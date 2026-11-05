import { CircleCheck, RotateCcw, TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { BookingReviewView } from '@/modules/finance/contracts';
import { CHANGE_CLASS_LABEL, CHANGED_FIELD_GROUP_LABEL, SERVICE_TYPE_LABEL, type ServiceType } from '@/modules/fulfilment/contracts';
import { REVIEW_STATUS_LABEL, dateText, inr } from './book-fields';

/*
 * Package booking details on the Accounts review card (B1.1, DEC-29): what
 * was sold, list price and discount, the payment plan Accounts reviews with
 * the booking, the booking contact, and for a fixed (revised) booking what
 * changed and by how much the price moved. Read only; Accounts never changes
 * the booking.
 */

function changedGroups(fields: string[]): string {
  return [...new Set(fields.map((f) => CHANGED_FIELD_GROUP_LABEL[f.split('.')[0]!] ?? f))].join(', ');
}

export function AccountsPackageReview({ booking }: { booking: BookingReviewView }) {
  const plan = booking.paymentPlan ?? null;
  const revision = booking.revision ?? null;
  return (
    <div className="mt-3 flex flex-col gap-4 font-sans text-base text-copy">
      {revision ? (
        <div className="flex flex-col gap-2 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-3">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning" icon={RotateCcw}>
              Fixed booking · replaces version {revision.revisesVersionNo}
            </StatusBadge>
            <span className="text-sm text-copy">{CHANGE_CLASS_LABEL[revision.changeClass].title}</span>
          </p>
          <p className="m-0 text-sm">
            Changed: {revision.changedFields.length > 0 ? changedGroups(revision.changedFields) : 'nothing listed'}
            {revision.sellingDeltaPaise && revision.sellingDeltaPaise !== '0'
              ? ` · selling total ${revision.sellingDeltaPaise.startsWith('-') ? 'down' : 'up'} by ${inr(revision.sellingDeltaPaise.replace('-', ''))}`
              : ' · selling total unchanged'}
          </p>
        </div>
      ) : null}
      <SummaryList>
        {booking.services && booking.services.length > 0 ? (
          <SummaryRow label="Services sold">
            {booking.services.map((s) => `${s.itemNo}. ${SERVICE_TYPE_LABEL[s.serviceType as ServiceType] ?? s.serviceType}`).join(' · ')}
          </SummaryRow>
        ) : null}
        <SummaryRow label="List price" numeric>
          {inr(booking.listPricePaise ?? null) ?? <NotEntered>Not given</NotEntered>}
        </SummaryRow>
        <SummaryRow label="Discount" numeric>
          {inr(booking.discountPaise ?? null) ?? <NotEntered>None</NotEntered>}
        </SummaryRow>
        {booking.contact ? (
          <SummaryRow label="Booking contact">
            {booking.contact.name} · {[booking.contact.mobile, booking.contact.email].filter(Boolean).join(' · ')}
            <span className="block text-sm text-quiet">
              {booking.contact.bookingFor === 'business' ? 'Business booking' : 'Individual booking'}
              {booking.contact.payerName ? ` · paid by ${booking.contact.payerName}` : ''}
            </span>
          </SummaryRow>
        ) : null}
      </SummaryList>
      <section aria-labelledby="fin-plan-heading" className="flex flex-col gap-2">
        <h3 id="fin-plan-heading" className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
          Payment plan
          {plan ? (
            plan.matchesSellingTotal ? (
              <StatusBadge tone="success" icon={CircleCheck}>
                Adds up to the selling total
              </StatusBadge>
            ) : (
              <StatusBadge tone="danger" icon={TriangleAlert}>
                Does not add up to the selling total
              </StatusBadge>
            )
          ) : null}
        </h3>
        {plan && plan.instalments.length > 0 ? (
          <SummaryList>
            {plan.instalments.map((i) => (
              <SummaryRow key={i.seq} label={`${i.seq}. ${i.label} · due ${dateText(i.dueDate)}`} numeric>
                {inr(i.amountPaise)}
              </SummaryRow>
            ))}
            <SummaryRow label="Plan total" numeric total>
              {inr(plan.totalPaise)}
            </SummaryRow>
          </SummaryList>
        ) : (
          <p className="m-0 text-quiet">No payment plan on this version.</p>
        )}
        <p className="m-0 text-sm text-quiet">Instalments are a plan, not money received. Approving the booking approves the plan as part of it.</p>
      </section>
      {booking.earlierVersions && booking.earlierVersions.length > 0 ? (
        <section aria-labelledby="fin-earlier-heading" className="flex flex-col gap-1.5">
          <h3 id="fin-earlier-heading" className="m-0 text-base font-semibold text-ink">
            Earlier versions
          </h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {booking.earlierVersions.map((v) => (
              <li key={v.versionNo}>
                Version {v.versionNo}: {REVIEW_STATUS_LABEL[v.reviewStatus as keyof typeof REVIEW_STATUS_LABEL] ?? v.reviewStatus}
                {v.returnReason ? ` · returned because: ${v.returnReason}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
