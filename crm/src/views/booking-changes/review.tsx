import { StatusBadge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { ROUTE_WORD } from './labels';
import { reviewServiceRows, type ReviewServiceRow } from './review-model';
import type { ChangeReviewView, ReviewSideView } from './types';

/*
 * Addendum O2 (owner, 13 November 2026): what the branch Manager approves —
 * the accepted booking and the filled change version side by side: trip
 * dates, selling total, payment plan and services, every changed line
 * marked in words ("Changed", "Added", "Removed"), never by colour alone.
 * The approval binds exactly this version (its content hash); when the
 * version was edited after it was sent (`sentVersionCurrent` false) the
 * screen says so and approving waits until it is sent again. A Server
 * Component (no state); the decide buttons stay in the approvals row.
 */

export function ChangeReviewPanel({ review }: { review: ChangeReviewView | 'error' }) {
  if (review === 'error') {
    return (
      <Notice tone="warning" role="status">
        <p>The old and new booking could not be loaded side by side. Reload the page before deciding.</p>
      </Notice>
    );
  }
  const r = review;
  const p = r.proposed;
  return (
    <section aria-label={`Old and new booking for ${r.refNo}`} className="flex flex-col gap-3">
      {!r.sentVersionCurrent ? (
        <Notice tone="warning" title="Changed after it was sent">
          <p>The Sales owner edited the booking after sending it. What you see is the latest version, not the one sent. Wait until they send it again with &quot;Send change&quot;; approving is not possible until then.</p>
        </Notice>
      ) : null}
      {!p ? (
        <Notice tone="info" title="Not filled in yet">
          <p>The Sales owner has not opened the change in the booking yet, so there is nothing to compare.</p>
        </Notice>
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-control border border-line bg-canvas p-3 text-sm">
          <div aria-hidden="true" className="hidden gap-2 font-semibold text-quiet sm:grid sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
            <span />
            <span>Confirmed now (version {r.base.versionNo})</span>
            <span>After the change (version {p.versionNo})</span>
          </div>
          <dl className="m-0 grid gap-2 sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
            <Compare label="Trip dates" before={tripText(r.base)} after={tripText(p)} beforeNo={r.base.versionNo} afterNo={p.versionNo} />
            <Compare label="Selling total" before={inr(r.base.sellingTotalPaise)} after={inr(p.sellingTotalPaise)} beforeNo={r.base.versionNo} afterNo={p.versionNo} numeric />
            {r.kind === 'remove_service' && r.removalRoute ? <Compare label="Removal" before="—" after={ROUTE_WORD[r.removalRoute]} beforeNo={r.base.versionNo} afterNo={p.versionNo} quiet /> : null}
            {r.customerChargePaise != null ? <Compare label="Customer charge" before="—" after={inr(r.customerChargePaise)} beforeNo={r.base.versionNo} afterNo={p.versionNo} numeric quiet /> : null}
          </dl>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <PlanColumn title={`Payment plan now (version ${r.base.versionNo})`} side={r.base} />
            <PlanColumn title={`Payment plan after the change (version ${p.versionNo})`} side={p} changed={planText(r.base) !== planText(p)} />
          </div>

          <section aria-label="Services, old and new" className="flex flex-col gap-2">
            <p className="m-0 text-sm font-semibold text-ink">Services</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {reviewServiceRows(r.base, p, r.changedItemIds).map((row) => (
                <li key={row.itemId}>
                  <ServiceCompare row={row} />
                </li>
              ))}
            </ul>
          </section>
          {r.changedFields.length > 0 ? <p className="m-0 text-sm text-quiet">Changed in this version: {r.changedFields.join(', ')}.</p> : null}
        </>
      )}
    </section>
  );
}

function Compare({ label, before, after, beforeNo, afterNo, numeric, quiet }: { label: string; before: string; after: string; beforeNo: number; afterNo: number; numeric?: boolean; quiet?: boolean }) {
  const changed = !quiet && before !== after;
  const num = numeric ? 'tabular-nums' : '';
  return (
    <>
      <dt className="font-medium text-ink">{label}</dt>
      <dd className={`m-0 text-copy ${num}`}>
        <span className="text-quiet sm:sr-only">Version {beforeNo}: </span>
        {before}
      </dd>
      <dd className={`m-0 flex flex-wrap items-center gap-1.5 text-ink ${num} ${changed ? 'rounded-chip bg-status-warning-tint px-1.5' : ''}`}>
        <span className="text-quiet sm:sr-only">Version {afterNo}: </span>
        {after}
        {changed ? <StatusBadge tone="warning">Changed</StatusBadge> : null}
      </dd>
    </>
  );
}

function PlanColumn({ title, side, changed }: { title: string; side: ReviewSideView; changed?: boolean }) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col gap-1.5 rounded-control border p-3 text-sm ${changed ? 'border-status-warning-line bg-status-warning-tint' : 'border-line'}`}>
      <p className="m-0 flex flex-wrap items-center gap-2 font-semibold text-ink">
        {title}
        {changed ? <StatusBadge tone="warning">Changed</StatusBadge> : null}
      </p>
      {side.plan.length === 0 ? (
        <p className="m-0 text-quiet">No payment plan.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {side.plan.map((i) => (
            <li key={i.seq} className="flex flex-wrap justify-between gap-x-3">
              <span className="text-copy">
                {i.label ?? `Instalment ${i.seq}`}
                {i.dueDate ? ` · due ${dayText(i.dueDate)}` : ''}
              </span>
              <span className="tabular-nums text-ink">{inr(i.amountPaise)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const ROW_WORD: Record<ReviewServiceRow['state'], { word: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  changed: { word: 'Changed', tone: 'warning' },
  added: { word: 'Added', tone: 'success' },
  removed: { word: 'Removed', tone: 'danger' },
  same: { word: 'No change', tone: 'neutral' },
};

function ServiceCompare({ row }: { row: ReviewServiceRow }) {
  const w = ROW_WORD[row.state];
  return (
    <article aria-label={`Service ${row.itemNo}: ${row.serviceTitle}`} className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 font-semibold wrap-anywhere text-ink">
          {row.itemNo}. {row.serviceTitle}
        </p>
        <StatusBadge tone={w.tone}>{w.word}</StatusBadge>
      </div>
      {row.state === 'same' ? null : (
        <dl className="m-0 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
          {row.lines.map((l) => (
            <div key={l.key} className="contents">
              <dt className="text-quiet">{l.label}</dt>
              <dd className="m-0 wrap-anywhere text-copy">
                <span className="text-quiet sm:sr-only">Now: </span>
                {l.before ?? '—'}
              </dd>
              <dd className={`m-0 flex flex-wrap items-center gap-1.5 wrap-anywhere text-ink ${l.changed ? 'rounded-chip bg-status-warning-tint px-1.5' : ''}`}>
                <span className="text-quiet sm:sr-only">After: </span>
                {l.after ?? '—'}
                {l.changed ? <StatusBadge tone="warning">Changed</StatusBadge> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function tripText(s: ReviewSideView): string {
  if (!s.tripStart && !s.tripEnd) return '—';
  return `${dayText(s.tripStart)} to ${dayText(s.tripEnd)}`;
}

function planText(s: ReviewSideView): string {
  return s.plan.map((i) => `${i.seq}|${i.amountPaise}|${i.dueDate ?? ''}|${i.label ?? ''}`).join(';');
}
