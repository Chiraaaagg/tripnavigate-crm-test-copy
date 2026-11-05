import {
  CircleCheck,
  CircleDashed,
  ClipboardCheck,
  Clock,
  FileCheck2,
  FlaskConical,
  Hotel,
  Hourglass,
  ListChecks,
  type LucideIcon,
  PencilLine,
  RefreshCw,
  Send,
  Truck,
  Undo2,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { DealHeaderVM, DealPrimaryAction, DealStatusWord } from '@/modules/deals/workspace-contract';
import { bitrixNameUnrecognised, formatIst } from '../deal-labels';
import { BitrixName, LateRecordNotice, OwnerValue } from '../list-parts';

/*
 * Deal record header (P-HEADER, DE-02, copy §16.3): customer and trip, status
 * word with an icon (never colour alone), Bitrix stage, owner, "From lead",
 * one "Next:" line and exactly ONE primary action (or none, when the viewer
 * does not act next). Catalog gap G9 (composition of the design-system page
 * header, badge, notice and button). Never carries money.
 */

const STATUS_LOOK: Record<DealStatusWord, { tone: StatusTone; icon: LucideIcon }> = {
  'Not started': { tone: 'neutral', icon: CircleDashed },
  'Quotation accepted': { tone: 'brand', icon: FileCheck2 },
  'Booking in progress': { tone: 'info', icon: PencilLine },
  'Ready to submit': { tone: 'info', icon: ClipboardCheck },
  'Waiting for Accounts': { tone: 'neutral', icon: Send },
  'Returned by Accounts': { tone: 'warning', icon: Undo2 },
  'Being arranged': { tone: 'info', icon: Truck },
  'All services confirmed': { tone: 'success', icon: CircleCheck },
  'Lost in Bitrix': { tone: 'danger', icon: XCircle },
  'Hotel booking': { tone: 'neutral', icon: Hotel },
  'Could not load': { tone: 'danger', icon: RefreshCw },
  // DA-44 words of the viewer's own task (department roles), and "Booking submitted".
  'Waiting to be taken': { tone: 'neutral', icon: Hourglass },
  'In progress': { tone: 'info', icon: PencilLine },
  'Confirmed by supplier': { tone: 'success', icon: CircleCheck },
  Completed: { tone: 'success', icon: CircleCheck },
  'Waiting for the Visa desk to start': { tone: 'neutral', icon: Hourglass },
  'Booking submitted': { tone: 'neutral', icon: Send },
};

/** Booking status word with its icon (DA-40). */
export function DealStatusBadge({ word }: { word: DealStatusWord }) {
  const look = STATUS_LOOK[word];
  return (
    <StatusBadge tone={look.tone} icon={look.icon}>
      <span className="sr-only">Booking status: </span>
      {word}
    </StatusBadge>
  );
}

/** The one primary action as a link (every kind except Start booking, which is the route's server-action form). */
function PrimaryLink({ action }: { action: Exclude<DealPrimaryAction, { kind: 'start_booking' }> }) {
  return (
    <Link href={action.href} className={buttonVariants({ variant: 'primary' })}>
      {action.label}
    </Link>
  );
}

export function DealWorkspaceHeader({ header, startBookingForm, live }: { header: DealHeaderVM; startBookingForm?: ReactNode; live?: ReactNode }) {
  const primary = header.primary;
  const actions =
    primary === null ? undefined : primary.kind === 'start_booking' ? (startBookingForm ?? undefined) : <PrimaryLink action={primary} />;
  const actor = header.next.actor;
  return (
    <>
      <PageHeader
        eyebrow={<span className="wrap-anywhere">{header.reference}</span>}
        title={<span className="block wrap-anywhere">{header.title}</span>}
        status={
          <>
            {header.status ? <DealStatusBadge word={header.status.word} /> : null}
            {header.stage ? (
              <span className="inline-flex items-center gap-1 text-copy">
                {/* DA-115: "Stage: {name}"; an unrecognised stage says so without the extra label. */}
                {bitrixNameUnrecognised(header.stage) ? null : <span className="text-quiet">Stage:</span>}
                <BitrixName name={header.stage} kind="stage" capitalDetails />
              </span>
            ) : null}
            {header.testRecord ? (
              <StatusBadge tone="warning" icon={FlaskConical}>
                Test record (not from Bitrix)
              </StatusBadge>
            ) : null}
            <OwnerValue owner={header.owner} withLabel />
            {header.leadLink ? (
              <span className="min-w-0 wrap-anywhere text-copy">
                From lead{' '}
                {/* Underlined: a link is never told apart by colour alone (WCAG 1.4.1). */}
                <Link
                  href={header.leadLink.href}
                  className={cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing)}
                >
                  {header.leadLink.reference}
                </Link>
              </span>
            ) : null}
            {live ? <div className="[&_.live-indicator]:m-0">{live}</div> : null}
          </>
        }
        actions={actions ? <div data-slot="deal-primary">{actions}</div> : undefined}
        className="mb-3"
      />
      <div className="mb-4 flex flex-col gap-2.5">
        <p className="m-0 text-copy" data-slot="deal-next">
          <span className="font-semibold text-ink">Next:</span> {header.next.text}
          {actor ? <span className="text-quiet"> · {actor}</span> : null}
        </p>
        {primary?.kind === 'start_booking' ? <p className="m-0 text-sm text-quiet">Starts the booking form. Nothing is booked or paid.</p> : null}
        {header.waitsForWon || header.servicesProgressText ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {header.waitsForWon ? (
              <StatusBadge tone="neutral" icon={Clock}>
                Waiting for Won - Payment Received
              </StatusBadge>
            ) : null}
            {header.servicesProgressText ? (
              <span className="inline-flex items-center gap-1.5 text-copy">
                <ListChecks aria-hidden="true" className="size-4 shrink-0 text-faint" />
                {header.servicesProgressText}
              </span>
            ) : null}
          </div>
        ) : null}
        {header.returnNotice ? (
          <Notice tone="warning" icon={Undo2} title="Returned by Accounts">
            {header.returnNotice.reviewedAt ? <p>Returned {formatIst(header.returnNotice.reviewedAt)}.</p> : null}
            {header.returnNotice.reason ? (
              <p>
                Reason: <span className="wrap-break-word">{header.returnNotice.reason}</span>
              </p>
            ) : header.returnNotice.reasonHidden ? (
              <p>Accounts did not share the reason for this return with Sales. Ask Accounts what to fix.</p>
            ) : null}
          </Notice>
        ) : null}
        {header.lostInBitrix ? (
          <Notice tone="locked" icon={XCircle}>
            {/* DA-29a: with a booking it stays readable; without one, none can be started. */}
            <p>
              {primary?.kind === 'view_booking'
                ? 'This deal is lost or rejected in Bitrix. You can read the booking; you cannot change it.'
                : 'This deal is lost or rejected in Bitrix, so a booking cannot be started.'}
            </p>
          </Notice>
        ) : null}
        {header.bitrixLate ? <LateRecordNotice thing="deal" /> : null}
      </div>
    </>
  );
}
