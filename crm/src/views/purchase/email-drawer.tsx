'use client';

import { Copy, Mail, Send } from 'lucide-react';
import { useActionState, useId, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button, buttonVariants } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';
import { PURCHASE_BUILD_TEXT, SUPPLIER_EMAIL_BODY_MAX, SUPPLIER_EMAIL_MAX_CC, SUPPLIER_EMAIL_SUBJECT_MAX, type SupplierChoice } from '@/modules/procurement/contracts';
import { guard, Hidden, ResultLine, Submit, useRequestId, type DecisionAction, type UiResult } from '../accounts/supplier-forms';
import { buildMailtoHref, buildSupplierEmailDraft, draftAsText } from '@/modules/procurement/email-draft';
import type { SupplierEmailKind } from '@/modules/procurement/contracts';
import { isEmailShaped, splitEmails } from './purchase-vm';
import { useWorkFlash } from './work-flash';

/*
 * Supplier e-mail drawer (prototype 1 Nov 2026): To, Cc, Subject, Message,
 * then "Copy draft", "Open in e-mail app" and "Mark as sent". When the
 * server switch supplier_email_sending_enabled is on, the last button is
 * "Send" (the CRM sends through its provider; replies go to the Purchase
 * person). Subjects carry the Deal ID. The draft never contains a selling
 * price: only the stay facts and, for a booking request, the final rate.
 * Typed text stays after a refusal (HandForm is never reset).
 */

export interface EmailDrawerProps {
  kind: SupplierEmailKind;
  taskId: string;
  dealReference: string;
  task: PurchaseTaskView;
  suppliers: SupplierChoice[];
  /** Booking request: the final rate's supplier (fixed). Rate request: the first choice. */
  supplierId: string | null;
  senderName: string;
  /** Booking request only: the final tile's cost version amount (exactly what the tile shows) and its offer's room and meal plan. */
  amountPaise?: string | null;
  offerRoomType?: string | null;
  offerMealPlan?: string | null;
  expectedVersionNo?: number;
  sendingEnabled: boolean;
  action: DecisionAction;
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  /** Help under the trigger, e.g. what the booking request also does. */
  triggerHelp?: string;
}

interface Problems {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
}

export function SupplierEmailDrawer(props: EmailDrawerProps) {
  const { kind, taskId, task, dealReference, suppliers, senderName, sendingEnabled, action, triggerLabel, triggerVariant = 'secondary', triggerHelp } = props;
  const base = useId();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState(props.supplierId ?? suppliers[0]?.supplierId ?? '');
  const supplier = suppliers.find((s) => s.supplierId === supplierId) ?? null;
  const draftFor = (s: SupplierChoice | null) => {
    // One source for drafts: the procurement module's pure builder (subject with the Deal ID, no selling price).
    return buildSupplierEmailDraft({
      kind,
      task,
      greetingName: s ? `${s.name} team` : 'Reservations team',
      senderName,
      agreedRatePaise: kind === 'booking_request' ? (props.amountPaise ?? null) : null,
      offerRoomType: props.offerRoomType ?? null,
      offerMealPlan: props.offerMealPlan ?? null,
    });
  };
  const [to, setTo] = useState(supplier?.email ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(() => draftFor(supplier).subject);
  const [body, setBody] = useState(() => draftFor(supplier).body);
  const [problems, setProblems] = useState<Problems>({});
  const [copied, setCopied] = useState<string | null>(null);
  const flash = useWorkFlash();
  const [state, run] = useActionState(async (prev: UiResult | null, fd: FormData) => {
    const result = await guard(action)(prev as never, fd);
    // The tile may swap this drawer's trigger after the save ("Send booking request again"): keep the result on the page.
    if (result.ok) flash(result.message);
    return result;
  }, null);
  const requestId = useRequestId(state);

  const ccList = splitEmails(cc);
  const changeSupplier = (id: string) => {
    setSupplierId(id);
    const s = suppliers.find((x) => x.supplierId === id) ?? null;
    setTo(s?.email ?? '');
    const d = draftFor(s);
    setSubject(d.subject);
    setBody(d.body);
  };

  const check = (): Problems => {
    const p: Problems = {};
    if (!isEmailShaped(to.trim())) p.to = 'Enter the supplier’s e-mail address, like name@hotel.com.';
    if (ccList.length > SUPPLIER_EMAIL_MAX_CC) p.cc = `At most ${SUPPLIER_EMAIL_MAX_CC} addresses in Cc.`;
    else if (ccList.some((c) => !isEmailShaped(c))) p.cc = 'One Cc address is not an e-mail address. Separate addresses with commas.';
    if (subject.trim().length === 0 || subject.length > SUPPLIER_EMAIL_SUBJECT_MAX) p.subject = `Write a subject of up to ${SUPPLIER_EMAIL_SUBJECT_MAX} characters.`;
    if (body.trim().length === 0 || body.length > SUPPLIER_EMAIL_BODY_MAX) p.body = `Write a message of up to ${SUPPLIER_EMAIL_BODY_MAX} characters.`;
    return p;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draftAsText({ to: to.trim(), cc: ccList, subject, body }));
      setCopied('Draft copied. Paste it into your e-mail.');
    } catch {
      setCopied('Your browser did not allow copying. Select the message and copy it by hand.');
    }
  };

  const T = PURCHASE_BUILD_TEXT;
  const title = kind === 'rate_request' ? 'Ask the supplier for rates' : 'Send the booking request';
  const submitLabel = sendingEnabled ? T.sendLabel : T.markAsSentLabel;
  const field = (name: keyof Problems) => `${base}-${name}`;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <div className="flex flex-col items-start gap-1">
        <DrawerTrigger asChild>
          <Button variant={triggerVariant} aria-describedby={triggerHelp ? `${base}-trigger-help` : undefined}>
            {kind === 'rate_request' ? <Mail aria-hidden="true" /> : <Send aria-hidden="true" />}
            {triggerLabel}
          </Button>
        </DrawerTrigger>
        {triggerHelp ? (
          <p id={`${base}-trigger-help`} className="m-0 max-w-prose text-sm text-quiet">
            {triggerHelp}
          </p>
        ) : null}
      </div>
      <DrawerContent className="w-[min(40rem,100vw)] max-sm:rounded-none" closeLabel="Close the e-mail">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          <DrawerDescription className="m-0 text-sm text-quiet">
            {dealReference} · {task.itemTitle}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-4">
          {state?.ok ? (
            <>
              <ResultLine state={state} />
              <div>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <HandForm
              action={run}
              noValidate
              aria-label={title}
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                const p = check();
                setProblems(p);
                const first = (Object.keys(p) as Array<keyof Problems>)[0];
                if (first) {
                  e.preventDefault();
                  document.getElementById(field(first))?.focus();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
              }}
            >
              <ResultLine state={state} />
              {!sendingEnabled ? (
                <Notice tone="info">
                  <p>{T.emailOffNotice}</p>
                </Notice>
              ) : (
                <Notice tone="info">
                  <p>The CRM sends this e-mail. Replies come to your own e-mail address.</p>
                </Notice>
              )}
              {kind === 'booking_request' && task.serviceType === 'hotel' ? (
                <Notice tone="info" title="Accounts is asked too">
                  <p>{T.bookingRequestHelp}</p>
                </Notice>
              ) : null}
              <Hidden
                fields={{
                  taskId,
                  supplierId,
                  requestId,
                  ...(props.expectedVersionNo !== undefined ? { expectedVersionNo: props.expectedVersionNo } : {}),
                }}
              />
              {kind === 'rate_request' && suppliers.length > 1 ? (
                <Field htmlFor={`${base}-supplier`} label="Supplier">
                  <Select id={`${base}-supplier`} value={supplierId} onChange={(e) => changeSupplier(e.target.value)}>
                    {suppliers.map((s) => (
                      <option key={s.supplierId} value={s.supplierId}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <p className="m-0 text-sm text-copy">
                  <span className="font-semibold text-ink">Supplier:</span> {supplier?.name ?? 'Not chosen'}
                </p>
              )}
              <Field htmlFor={field('to')} label="To" hint={supplier && !supplier.email ? 'No e-mail is saved for this supplier. Type it here; add it to the supplier record later.' : undefined} error={problems.to}>
                <Input
                  id={field('to')}
                  name="to"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  maxLength={254}
                  invalid={!!problems.to}
                  aria-describedby={fieldDescribedBy(field('to'), { hint: supplier && !supplier.email, error: problems.to })}
                />
              </Field>
              <Field htmlFor={field('cc')} label="Cc" optional hint="Several addresses: separate them with commas." error={problems.cc}>
                <Input
                  id={field('cc')}
                  name="cc"
                  inputMode="email"
                  autoComplete="off"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  invalid={!!problems.cc}
                  aria-describedby={fieldDescribedBy(field('cc'), { hint: true, error: problems.cc })}
                />
              </Field>
              <Field htmlFor={field('subject')} label="Subject" error={problems.subject}>
                <Input
                  id={field('subject')}
                  name="subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={SUPPLIER_EMAIL_SUBJECT_MAX}
                  invalid={!!problems.subject}
                  aria-describedby={fieldDescribedBy(field('subject'), { error: problems.subject })}
                />
              </Field>
              <Field htmlFor={field('body')} label="Message" error={problems.body}>
                <Textarea
                  id={field('body')}
                  name="body"
                  rows={12}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={SUPPLIER_EMAIL_BODY_MAX}
                  invalid={!!problems.body}
                  aria-describedby={fieldDescribedBy(field('body'), { error: problems.body })}
                  className="font-mono text-sm sm:text-sm"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={copy}>
                  <Copy aria-hidden="true" />
                  {T.copyDraftLabel}
                </Button>
                <a href={buildMailtoHref({ to: to.trim(), cc: ccList, subject, body })} className={buttonVariants({ variant: 'secondary' })}>
                  <Mail aria-hidden="true" />
                  {T.openInEmailAppLabel}
                </a>
                <Submit label={submitLabel} pendingLabel={sendingEnabled ? 'Sending…' : 'Recording…'} />
              </div>
              <p role="status" aria-live="polite" className="m-0 text-sm text-quiet">
                {copied}
              </p>
            </HandForm>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
