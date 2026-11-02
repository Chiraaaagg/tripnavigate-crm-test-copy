import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPaise } from '@/modules/deals/dto';
import { SERVICE_TYPE_LABEL, type PurchaseTaskView } from '@/modules/fulfilment/contracts';
import { formatDateOnly } from '../booking-views';
import { budgetText } from '../department/task-frame';
import { FactsBlock } from '../service-labels';
import { hotelBreakup } from './purchase-vm';

/*
 * "What Sales booked for this hotel" (owner review of the prototype, 1 Nov
 * 2026): stay, travellers, meal plan, inclusions, the room breakup from the
 * Book now cost estimate (rooms × cost per room per night, extra beds, guests
 * without a bed) and the total budget. Without a breakup it shows what exists
 * and says Sales gave none. The special request is a warning notice with an
 * icon and the words "Special request". Cost side only: no selling price.
 */

const dlClass = 'm-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,11rem)_1fr]';
const dtClass = 'text-sm font-medium text-quiet';
const ddClass = 'm-0 min-w-0 wrap-break-word text-ink';

function travellersText(t: PurchaseTaskView['travellers']): string {
  const adults = `${t.adults} ${t.adults === 1 ? 'adult' : 'adults'}`;
  return t.children > 0 ? `${adults}, ${t.children} ${t.children === 1 ? 'child' : 'children'}` : adults;
}

function nightsText(n: number): string {
  return `${n} ${n === 1 ? 'night' : 'nights'}`;
}

/** The stay facts, breakup table, total budget and special request (shared by Details and Work). */
export function BookedFacts({ task }: { task: PurchaseTaskView }) {
  const breakup = hotelBreakup(task);
  const hotel = task.serviceType === 'hotel';
  return (
    <div className="flex flex-col gap-4">
      {hotel ? (
        <dl className={dlClass}>
          <dt className={dtClass}>Stay</dt>
          <dd className={ddClass}>
            {task.checkIn && task.checkOut ? (
              <>
                <span className="whitespace-nowrap">{formatDateOnly(task.checkIn)}</span> → <span className="whitespace-nowrap">{formatDateOnly(task.checkOut)}</span> · {nightsText(task.nights)}
              </>
            ) : (
              'Dates not set'
            )}
          </dd>
          <dt className={dtClass}>Travellers</dt>
          <dd className={ddClass}>{travellersText(task.travellers)}</dd>
          {!breakup ? (
            <>
              <dt className={dtClass}>Rooms</dt>
              <dd className={ddClass}>
                {task.rooms}
                {task.roomType ? ` × ${task.roomType}` : ''}
              </dd>
            </>
          ) : null}
          <dt className={dtClass}>Meal plan</dt>
          <dd className={ddClass}>{task.mealPlan ?? 'Not specified'}</dd>
          <dt className={dtClass}>Inclusions</dt>
          <dd className={cn(ddClass, 'whitespace-pre-wrap')}>{task.inclusions ?? 'Not specified'}</dd>
        </dl>
      ) : (
        <FactsBlock facts={task.facts} />
      )}
      {hotel && breakup ? (
        <Table label="Room breakup from Book now" wrapperClassName="rounded-control border border-line" stackOnMobile>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Room or bed</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead numeric>Cost per night</TableHead>
              <TableHead numeric>Nights</TableHead>
              <TableHead numeric>Line total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {breakup.lines.map((l) => (
              <TableRow key={l.key} className="align-top">
                <TableCell label="Room or bed" className="font-medium text-ink">
                  {l.label}
                </TableCell>
                <TableCell label="Quantity">{l.quantityText}</TableCell>
                <TableCell label="Cost per night" numeric>
                  {l.ratePaise ? (
                    <>
                      {formatPaise(l.ratePaise)}
                      <span className="block text-sm font-normal text-quiet">{l.rateUnit}</span>
                    </>
                  ) : (
                    <span className="font-normal text-quiet">No rate given</span>
                  )}
                </TableCell>
                <TableCell label="Nights" numeric>
                  {l.nights}
                </TableCell>
                <TableCell label="Line total" numeric>
                  {l.totalPaise ? formatPaise(l.totalPaise) : <span className="font-normal text-quiet">Not known</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : hotel ? (
        <p className="m-0 text-sm text-quiet">Sales did not give a room breakup.</p>
      ) : null}
      <dl className={cn(dlClass, 'border-t border-line pt-3')}>
        <dt className={cn(dtClass, 'font-semibold text-ink')}>Total budget</dt>
        <dd className={cn(ddClass, 'font-semibold tabular-nums')}>
          {budgetText(task.purchaseBudgetPaise)}
          {breakup?.perNightPaise && breakup.totalPaise === task.purchaseBudgetPaise ? (
            <span className="font-normal text-quiet">
              {' '}
              ({formatPaise(breakup.perNightPaise)} a night × {nightsText(breakup.nights)})
            </span>
          ) : null}
        </dd>
      </dl>
      {task.specialRequests ? (
        <Notice tone="warning" title="Special request">
          <p className="whitespace-pre-wrap wrap-break-word">{task.specialRequests}</p>
        </Notice>
      ) : null}
    </div>
  );
}

/** Details tab card. */
export function WhatSalesBookedCard({ task, id = 'task-booked', actions }: { task: PurchaseTaskView; id?: string; actions?: ReactNode }) {
  const what = task.serviceType === 'hotel' ? 'this hotel' : `this ${SERVICE_TYPE_LABEL[task.serviceType].toLowerCase()}`;
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id}>What Sales booked for {what}</CardTitle>
            <CardDescription>
              Entered by {task.confirmedByName} in Book now. {task.serviceType === 'hotel' ? 'The rates are Sales’ cost estimate, which is your budget.' : 'The budget is Sales’ cost estimate.'}
            </CardDescription>
          </div>
          {actions}
        </CardHeader>
        <CardBody>
          <BookedFacts task={task} />
        </CardBody>
      </section>
    </Card>
  );
}
