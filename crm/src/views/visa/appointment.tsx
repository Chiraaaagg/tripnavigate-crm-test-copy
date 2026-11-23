'use client';

import { CalendarDays, ChevronDown, CircleCheck } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayText, inr, whenText } from './format';
import { COST_KIND_LABEL, nameOf, plural } from './labels';
import type { WorkCtx } from './passengers';
import type { VisaApplicant } from './types';
import { draftFees, feeTotal, handoverTitle, isApplied, isPassportTask, kindOf, methodText, selectable, visaLine } from './work-model';

/*
 * Appointment (contract 11.1, HTML appointmentTable H:15265, bulk bar
 * H:15160, cells H:15231–15262): every ready or applied passenger with a
 * Select box, the passenger (visa line, "Applied with …", remark), the
 * appointment, the application, the decision and the handover. Returned and
 * receipt-less fees sit on top with "Fix fee" / "Send fee to Accounts".
 * The HTML opens popups from a <select>; here each cell has a button or a
 * menu button instead (a select that opens a dialog on change misfires with
 * the keyboard), which is the only change of interaction.
 */

const sub = 'block text-[0.8125rem] leading-snug text-quiet wrap-anywhere';

function Sel({ ctx, a, checked, onToggle }: { ctx: WorkCtx; a: VisaApplicant; checked: boolean; onToggle: (on: boolean) => void }) {
  if (!(a.can.select && !isApplied(a))) return null;
  return (
    <input
      type="checkbox"
      id={`sel-${ctx.ws.taskId}-${a.applicationId}`}
      className={cn('m-0 mt-0.5 size-4.5 cursor-pointer accent-brand-strong', focusRing)}
      aria-label={`Select ${nameOf(a)}`}
      checked={checked}
      onChange={(e) => onToggle(e.currentTarget.checked)}
    />
  );
}

function ApplicationCell({ ctx, a }: { ctx: WorkCtx; a: VisaApplicant }) {
  if (!isApplied(a)) {
    if (!a.can.select) return <StatusBadge tone="neutral">Not applied</StatusBadge>;
    const id = `apply-${a.applicationId}`;
    return (
      <Button id={id} size="sm" onClick={() => ctx.open({ kind: 'apply', ids: [a.applicationId] }, id)}>
        Mark as applied<span className="sr-only"> for {nameOf(a)}</span>
      </Button>
    );
  }
  const total = feeTotal(a.fees);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusBadge tone="info" icon={CircleCheck}>
        Applied
      </StatusBadge>
      {a.applied ? (
        <>
          <span className={sub}>Ref {a.applied.reference ?? 'not recorded'}</span>
          <span className={sub}>{dayText(a.applied.appliedOn)}</span>
        </>
      ) : null}
      {total ? <span className={sub}>Fee {total}</span> : null}
    </span>
  );
}

function DecisionCell({ ctx, a }: { ctx: WorkCtx; a: VisaApplicant }) {
  if (!isApplied(a)) return <span className="text-quiet">—</span>;
  const o = a.decision?.outcome;
  if (o === 'approved') return <StatusBadge tone="success">Approved</StatusBadge>;
  if (o === 'rejected') {
    const id = `reapply-${a.applicationId}`;
    return (
      <span className="flex flex-col items-start gap-1">
        <StatusBadge tone="danger">Rejected</StatusBadge>
        {a.decision?.reason ? <span className={sub}>{a.decision.reason}</span> : <span className={sub}>Reason not recorded</span>}
        {a.can.reapply ? (
          <Button id={id} variant="link" size="sm" onClick={() => ctx.open({ kind: 'reapply', id: a.applicationId }, id)}>
            Apply again<span className="sr-only"> for {nameOf(a)}</span>
          </Button>
        ) : null}
      </span>
    );
  }
  if (o === 'withdrawn') return <StatusBadge tone="neutral">Withdrawn</StatusBadge>;
  if (!a.can.decide && !a.can.withdraw) return <StatusBadge tone="warning">Pending</StatusBadge>;
  const id = `decide-${a.applicationId}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button id={id} size="sm">
          Record decision<span className="sr-only"> for {nameOf(a)}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {a.can.decide ? <DropdownMenuItem onSelect={() => ctx.open({ kind: 'approve', id: a.applicationId }, id)}>Approved</DropdownMenuItem> : null}
        {a.can.decide ? <DropdownMenuItem onSelect={() => ctx.open({ kind: 'reject', id: a.applicationId }, id)}>Rejected</DropdownMenuItem> : null}
        {a.can.withdraw ? <DropdownMenuItem onSelect={() => ctx.open({ kind: 'withdraw', id: a.applicationId }, id)}>Withdrawn by customer</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HandoverCell({ ctx, a }: { ctx: WorkCtx; a: VisaApplicant }) {
  const h = a.handover;
  const btn = (kind: 'handover' | 'delivered', label: string) => {
    const id = `${kind}-${a.applicationId}`;
    return (
      <Button id={id} variant="link" size="sm" className="mt-0.5" onClick={() => ctx.open({ kind, id: a.applicationId }, id)}>
        {label}
        <span className="sr-only"> for {nameOf(a)}</span>
      </Button>
    );
  };
  const remark = h?.remark ? <span className={sub}>{h.remark}</span> : null;
  if (a.state === 'withdrawn') {
    return (
      <span className="flex flex-col items-start">
        <span className={sub}>Customer told</span>
        {h?.method ? <span className={sub}>{methodText(a)}</span> : null}
      </span>
    );
  }
  if (a.state !== 'issued' && a.state !== 'refused') return <span className="text-quiet">—</span>;
  if (h?.kind === 'evisa') {
    return (
      <span className="flex flex-col items-start">
        <span className="font-medium text-ink">E-visa sent to {h.recipientEmail ?? 'the customer'}</span>
        {h.sentAt ? <span className={sub}>{dayText(h.sentAt.slice(0, 10))}</span> : null}
        {remark}
      </span>
    );
  }
  if (h?.kind === 'customer_told') return <span className={sub}>Customer told about the refusal</span>;
  if (h?.kind === 'legacy_returned') return <span className={sub}>Returned {dayText(h.deliveredOn ?? a.closed?.at?.slice(0, 10) ?? null, '')}</span>;
  const kind = kindOf(a);
  if (!h?.method) {
    // Legacy rows decided before the kind or handover was recorded: "Not recorded" + "Record handover".
    if (!isPassportTask(ctx.ws) && !kind) {
      return (
        <span className="flex flex-col items-start">
          <span className={sub}>Not recorded</span>
          {a.can.handover ? btn('handover', 'Record handover') : null}
        </span>
      );
    }
    if (kind === 'e_visa') {
      return (
        <span className="flex flex-col items-start">
          <span className={sub}>{a.state === 'refused' ? 'Customer not told yet' : 'E-visa not sent yet'}</span>
          {a.can.handover ? btn('handover', 'Record handover') : null}
        </span>
      );
    }
    return (
      <span className="flex flex-col items-start">
        <span className="font-medium text-ink">{handoverTitle(ctx.ws, a)}</span>
        <span className={sub}>Not decided yet</span>
        {a.can.handover ? btn('handover', 'Set handover') : null}
        {remark}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start">
      <span className="font-medium text-ink">{handoverTitle(ctx.ws, a)}</span>
      <span className={sub}>{methodText(a)}</span>
      {h.courierNumber ? <span className={sub}>Courier number {h.courierNumber}</span> : null}
      {h.deliveredOn ? <span className={sub}>Delivered {dayText(h.deliveredOn)}</span> : a.can.deliver ? btn('delivered', 'Mark delivered') : null}
      {remark}
    </span>
  );
}

function FeeNotices({ ctx }: { ctx: WorkCtx }) {
  const returned = ctx.ws.returnedFees;
  const drafts = draftFees(ctx.ws);
  if (returned.length === 0 && drafts.length === 0) return null;
  return (
    <CardBody className="flex flex-col gap-3 border-b border-line">
      {returned.map((f) => {
        const id = `fix-${f.entryId}`;
        return (
          <Notice key={f.entryId} tone="danger" title={`Accounts returned ${COST_KIND_LABEL[f.costKind]}${f.applicantName ? ` of ${f.applicantName}` : ''} · ${inr(f.amountPaise)}`}>
            <p>{f.returnReason || 'No reason given.'}</p>
            {ctx.managingFees ? (
              <div>
                <Button id={id} size="sm" onClick={() => ctx.open({ kind: 'fee', entryId: f.entryId }, id)}>
                  Fix fee
                </Button>
              </div>
            ) : null}
          </Notice>
        );
      })}
      {drafts.map(({ a, f }) => {
        const id = `send-${f.entryId}`;
        return (
          <Notice key={f.entryId} tone="warning" title={`${COST_KIND_LABEL[f.costKind]} of ${nameOf(a)} · ${inr(f.amountPaise)} is waiting for a receipt`}>
            <p>Company-paid fees go to Accounts once the receipt is attached.</p>
            {ctx.managingFees ? (
              <div>
                <Button id={id} size="sm" onClick={() => ctx.open({ kind: 'fee', entryId: f.entryId }, id)}>
                  Send fee to Accounts
                </Button>
              </div>
            ) : null}
          </Notice>
        );
      })}
    </CardBody>
  );
}

export function AppointmentCard({ ctx, rows, selected, setSelected }: { ctx: WorkCtx; rows: VisaApplicant[]; selected: string[]; setSelected: (ids: string[]) => void }) {
  const pickable = selectable(ctx.ws).map((a) => a.applicationId);
  const chosen = selected.filter((id) => pickable.includes(id));
  const all = pickable.length > 0 && chosen.length === pickable.length;
  const bulkId = `bulk-${ctx.ws.taskId}`;
  const applied = rows.filter(isApplied).length;
  return (
    <Card>
      <section aria-labelledby={`visa-appt-${ctx.ws.taskId}`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`visa-appt-${ctx.ws.taskId}`}>Appointment</CardTitle>
            <CardDescription>
              {ctx.working
                ? 'Mark passengers applied, one at a time or together, then record the decision and the handover.'
                : 'Passengers with every document and a date, with their application, decision and handover.'}
            </CardDescription>
          </div>
        </CardHeader>
        <FeeNotices ctx={ctx} />
        {rows.length === 0 ? (
          <p className="m-0 px-4.5 py-5 text-quiet" role="status">
            Nobody here yet. A passenger appears here once they have an appointment date and every document received.
          </p>
        ) : (
          <>
            {pickable.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3 border-b border-line bg-brand-tint/40 px-4.5 py-2.5">
                <label htmlFor={`sel-all-${ctx.ws.taskId}`} className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
                  <input
                    id={`sel-all-${ctx.ws.taskId}`}
                    type="checkbox"
                    className={cn('m-0 size-4.5 accent-brand-strong', focusRing)}
                    checked={all}
                    onChange={(e) => setSelected(e.currentTarget.checked ? pickable : [])}
                  />
                  Select all
                </label>
                <span className="text-sm text-quiet" role="status">
                  {chosen.length} of {pickable.length} selected
                </span>
                <span className="ml-auto max-sm:ml-0 max-sm:w-full">
                  <Button
                    id={bulkId}
                    variant={chosen.length ? 'primary' : 'secondary'}
                    className="max-sm:w-full"
                    aria-disabled={chosen.length === 0 || undefined}
                    aria-describedby={chosen.length === 0 ? `${bulkId}-why` : undefined}
                    onClick={() => (chosen.length ? ctx.open({ kind: 'apply', ids: chosen }, bulkId) : undefined)}
                  >
                    Confirm applied
                  </Button>
                  {chosen.length === 0 ? (
                    <span id={`${bulkId}-why`} className="sr-only">
                      Select at least one passenger first.
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}
            <Table label="Appointment table, scrolls sideways on small screens" wrapperClassName="rounded-b-card" className="min-w-[52rem] table-fixed">
              <TableCaption className="caption-top border-b border-line py-3 text-left font-medium text-copy">
                {plural(rows.length, 'passenger')} · {applied} applied
              </TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-16">Select</TableHead>
                  <TableHead className="w-[27%]">Passenger</TableHead>
                  <TableHead className="w-[17%]">Appointment</TableHead>
                  <TableHead className="w-[19%]">Application</TableHead>
                  <TableHead className="w-40">Decision</TableHead>
                  <TableHead>Handover</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const line = visaLine(ctx.ws, a);
                  return (
                    <TableRow key={a.applicationId} className="align-top">
                      <TableCell className="align-top">
                        <Sel ctx={ctx} a={a} checked={chosen.includes(a.applicationId)} onToggle={(on) => setSelected(on ? [...chosen, a.applicationId] : chosen.filter((x) => x !== a.applicationId))} />
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                          <span className="font-semibold wrap-anywhere text-ink">{nameOf(a)}</span>
                          {a.passport ? <span className="font-mono text-[0.8125rem] text-copy">{a.passport.number ? `Passport ${a.passport.number}` : 'Passport no. not recorded'}</span> : null}
                          {line ? <span className={sub}>{line}</span> : null}
                          {a.applied?.clubWith.length ? <span className={sub}>Applied with {a.applied.clubWith.join(', ')}</span> : null}
                          {a.applied?.remark ? <span className={sub}>{a.applied.remark}</span> : null}
                          {a.removed ? <StatusBadge tone="warning">Removed from the booking</StatusBadge> : null}
                          {a.secondApplication ? <StatusBadge tone="brand">Second application</StatusBadge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-start gap-1.5">
                            <CalendarDays aria-hidden="true" className="mt-0.75 size-4 shrink-0 text-faint" />
                            <span>{whenText(a.appointment.date, a.appointment.time, kindOf(a) === 'e_visa' ? 'Not needed' : 'Not set')}</span>
                          </span>
                          <span className={cn(sub, 'flex items-center gap-1')}>
                            <CircleCheck aria-hidden="true" className="size-3.5 text-status-success" />
                            {plural(a.documentsReceived, 'document')} received
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <ApplicationCell ctx={ctx} a={a} />
                      </TableCell>
                      <TableCell className="align-top">
                        <DecisionCell ctx={ctx} a={a} />
                      </TableCell>
                      <TableCell className="align-top">
                        <HandoverCell ctx={ctx} a={a} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </section>
    </Card>
  );
}
