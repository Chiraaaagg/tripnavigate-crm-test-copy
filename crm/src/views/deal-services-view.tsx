import { ListChecks, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { type DealServicesView, SERVICE_DEPARTMENT_LABEL, type ServiceItemView } from '@/modules/fulfilment/contracts';
import {
  ProgressPill,
  serviceNextHref,
  serviceNextLinkText,
  serviceNextStepText,
  serviceOwnerText,
  ServiceStatePill,
  ServiceTypePill,
} from './service-labels';

/*
 * "Services sold" card on the Deal page (B1, Lagoon): one row per sold
 * service with its type, title, department, owner, state (icon + word) and
 * next step with a link. Placed by the route in the Deal page's work column
 * above the hotel panel. Pattern (21st.dev, idea only): a task list card with
 * status per row and an assignee (tailwind-admin 27738), rebuilt as a plain
 * ordered list inside the foundation's Card.
 */

export function DealServicesCard({
  services,
  intakeHref,
  linkLabel = 'Open intake',
}: {
  services: DealServicesView;
  /** The intake screen, offered to editors while service items are switched on. */
  intakeHref?: string | null;
  /** B1.1: "Open the booking" when the link leads to the Book now form. */
  linkLabel?: string;
}) {
  const items = services.items;
  return (
    <Card>
      <section aria-labelledby="services-heading" id="services-sold">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="services-heading">Services sold</CardTitle>
            <CardDescription>
              {services.version
                ? `Booking version ${services.version.versionNo} · ${services.version.status === 'confirmed' ? 'submitted' : 'draft'}`
                : 'Not submitted yet'}
            </CardDescription>
          </div>
          <ProgressPill progress={services.progress} />
        </CardHeader>
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No services yet"
            description={intakeHref ? 'Add the sold services in the booking; tasks are created when it is submitted.' : 'The deal owner adds the sold services on the intake screen.'}
            action={
              intakeHref ? (
                <Link href={intakeHref} className={buttonVariants({ variant: 'secondary' })}>
                  {linkLabel}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Sold services">
              {items.map((item) => (
                <ServiceRow key={item.itemId} item={item} dealId={services.dealId} />
              ))}
            </ol>
            {intakeHref ? (
              <CardBody className="border-t border-line py-3">
                <Link href={intakeHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  {linkLabel}
                </Link>
              </CardBody>
            ) : null}
          </>
        )}
      </section>
    </Card>
  );
}

function ServiceRow({ item, dealId }: { item: ServiceItemView; dealId: string }) {
  return (
    <li className="m-0 flex flex-col gap-2 px-4.5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ServiceTypePill type={item.serviceType} />
          <span className="font-semibold wrap-break-word text-ink">{item.title}</span>
        </div>
        <ServiceStatePill item={item} />
      </div>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm max-sm:grid-cols-1">
        <dt className="font-medium text-quiet">Department</dt>
        <dd className="m-0 text-copy">{SERVICE_DEPARTMENT_LABEL[item.department]}</dd>
        <dt className="font-medium text-quiet">Owner</dt>
        <dd className="m-0 text-copy">{serviceOwnerText(item)}</dd>
        <dt className="font-medium text-quiet">Next step</dt>
        <dd className="m-0 text-copy">
          {serviceNextStepText(item)}{' '}
          <Link href={serviceNextHref(item, dealId)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
            {serviceNextLinkText(item)}
          </Link>
        </dd>
      </dl>
    </li>
  );
}

/** Shown on the deal page when the services could not be loaded (never a fake empty state). */
export function DealServicesUnavailable() {
  return (
    <Card className="border-status-danger-line">
      <section aria-labelledby="services-heading">
        <CardHeader>
          <CardTitle id="services-heading">Services sold</CardTitle>
          <StatusBadge tone="danger" icon={RefreshCw} wrap>
            <span className="sr-only">Services status: </span>
            Could not load the services
          </StatusBadge>
        </CardHeader>
        <CardBody>
          <p className="m-0 text-copy">Reload the page. Nothing was changed. If it keeps happening, tell your admin.</p>
        </CardBody>
      </section>
    </Card>
  );
}

/**
 * Batch 1 Services and tasks tab when the viewer has neither a booking card
 * nor a services card (D-12: one empty state for the whole booking area,
 * never two). The header's primary action, when there is one, starts the work.
 */
export function DealServicesEmpty() {
  return (
    <Card role="status">
      <EmptyState icon={ListChecks} headingLevel={2} title="Nothing to show here yet" description="Services and team tasks show here after a booking starts, for the roles that work on them." />
    </Card>
  );
}

/**
 * Services and tasks tab when the header already carries the booking action and
 * no services card applies yet: one line pointing to that single primary action.
 */
export function DealServicesUseHeader({ primaryLabel }: { primaryLabel: string }) {
  // DA-117: names the header's one primary action.
  return <p className="m-0 text-base text-copy">No services yet. Use “{primaryLabel}” at the top of this page.</p>;
}
