import { ChevronLeft, FileQuestion, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/*
 * Deal page leaf parts kept after the Direction A Batch 1 workspace
 * (src/views/deal-workspace/*) replaced the page body: the not-found page,
 * the hotel-booking could-not-load card (re-exported by booking-views) and
 * the route loading skeleton. This module imports no other view module, so
 * the route loading file stays light and there is no import cycle.
 */

/** Same response for "does not exist" and "not yours", so IDs cannot be probed. */
export function DealNotFoundView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Deal not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">This deal does not exist, or it is not visible to you.</p>
        </div>
      </Card>
      {/* Outside the status card, so the live region announces only the message. */}
      <p className="m-0 mt-4">
        <Link href="/app/deals" className={buttonVariants({ variant: 'secondary' })}>
          <ChevronLeft aria-hidden="true" />
          Back to deals
        </Link>
      </p>
    </div>
  );
}

/** Shown on the deal page when the booking could not be loaded (never a fake empty state). */
export function HotelBookingUnavailable() {
  return (
    <Card className="border-status-danger-line">
      <section aria-labelledby="booking-heading">
        <CardHeader>
          <CardTitle id="booking-heading">Hotel booking</CardTitle>
          <StatusBadge tone="danger" icon={RefreshCw} wrap>
            <span className="sr-only">Booking status: </span>
            Did not load
          </StatusBadge>
        </CardHeader>
        <CardBody>
          <p className="m-0">The hotel booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
        </CardBody>
      </section>
    </Card>
  );
}

/**
 * Loading state of the deal page (route loading file): a visually hidden
 * "Deal" heading, then the Batch 1 workspace shape (back link, header with
 * one action, Next line, tabs, one card) as grey shapes. Announced once,
 * politely; the shapes are hidden from screen readers and the placeholder
 * area is busy.
 */
export function DealPageLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      {/* The page keeps one level-1 heading while it loads (visually hidden; the real one replaces it). */}
      <h1 className="sr-only">Deal</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading deal…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-28" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-96 max-w-full" />
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-6 w-36 rounded-full" />
              <Skeleton className="h-6 w-44 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-10 w-40 rounded-control" />
        </div>
        <Skeleton className="h-4 w-64 max-w-full" />
        <div className="flex gap-4 border-b border-line pb-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5 w-20" />
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}
