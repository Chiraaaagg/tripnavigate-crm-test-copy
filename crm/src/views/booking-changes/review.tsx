import { StatusBadge } from '@/components/ui/badge';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { ROUTE_WORD } from './labels';
import { reviewServiceRows, type ReviewLine, type ReviewServiceRow } from './review-model';
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
 *
 * Redesign R3 (DM-25): what changed comes first; everything that stays the
 * same (trip facts, the payment plan, services and lines) is folded behind
 * "Show unchanged details", and dates read the usual way ("12 Dec 2026").
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
  if (!p) {
    return (
      <section aria-label={`Old and new booking for ${r.refNo}`} className="flex flex-col gap-3">
        <StaleNotice show={!r.sentVersionCurrent} />
        <Notice tone="info" title="Not filled in yet">
          <p>The Sales owner has not opened the change in the booking yet, so there is nothing to compare.</p>
        </Notice>
      </section>
    );
  }

  const facts: CompareRow[] = [
    { label: 'Trip dates', before: tripText(r.base), after: tripText(p) },
    { label: 'Selling total', before: inr(r.base.sellingTotalPaise), after: inr(p.sellingTotalPaise), numeric: true },
  ];
  const extraFacts: CompareRow[] = [
    ...(r.kind === 'remove_service' && r.removalRoute ? [{ label: 'Removal', before: '—', after: ROUTE_WORD[r.removalRoute], quiet: true }] : []),
    ...(r.customerChargePaise != null ? [{ label: 'Customer charge', before: '—', after: inr(r.customerChargePaise), numeric: true, quiet: true }] : []),
  ];
  const changedFacts = [...facts.filter((f) => f.before !== f.after), ...extraFacts];
  const sameFacts = facts.filter((f) => f.before === f.after);
  const planChanged = planText(r.base) !== planText(p);
  const rows = reviewServiceRows(r.base, p, r.changedItemIds);
  const changedRows = rows.filter((row) => row.state !== 'same');
  const sameRows = rows.filter((row) => row.state === 'same');
  const unchangedCount = sameFacts.length + (planChanged ? 0 : 1) + sameRows.length;
  const versions = { beforeNo: r.base.versionNo, afterNo: p.versionNo };

  return (
    <section aria-label={`Old and new booking for ${r.refNo}`} className="flex flex-col gap-3">
      <StaleNotice show={!r.sentVersionCurrent} />
      <p className="m-0 text-sm font-semibold text-ink">What changes</p>
      {changedFacts.length > 0 ? <CompareTable rows={changedFacts} {...versions} /> : null}

      {planChanged ? (
        <div className="grid gap-3 md:grid-cols-2">
          <PlanColumn title={`Payment plan now (version ${r.base.versionNo})`} side={r.base} />
          <PlanColumn title={`Payment plan after the change (version ${p.versionNo})`} side={p} changed />
        </div>
      ) : null}

      {changedRows.length > 0 ? (
        <section aria-label="Services that change" className="flex flex-col gap-2">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {changedRows.map((row) => (
              <li key={row.itemId}>
                <ServiceCompare row={row} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {changedFacts.length === 0 && !planChanged && changedRows.length === 0 ? (
        <p className="m-0 text-sm text-copy">No trip fact, payment plan or service differs from the confirmed booking.</p>
      ) : null}
      {r.changedFields.length > 0 ? <p className="m-0 text-sm text-quiet">Changed in this version: {r.changedFields.join(', ')}.</p> : null}

      {unchangedCount > 0 ? (
        <Fold summary="Show unchanged details" meta={`${unchangedCount} the same in both`} className="shadow-none" bodyClassName="flex flex-col gap-3">
          {sameFacts.length > 0 ? <CompareTable rows={sameFacts} {...versions} /> : null}
          {!planChanged ? <PlanColumn title={`Payment plan (the same in versions ${r.base.versionNo} and ${p.versionNo})`} side={p} /> : null}
          {sameRows.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Services that stay the same">
              {sameRows.map((row) => (
                <li key={row.itemId}>
                  <ServiceCompare row={row} />
                </li>
              ))}
            </ul>
          ) : null}
        </Fold>
      ) : null}
    </section>
  );
}

function StaleNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Notice tone="warning" title="Changed after it was sent">
      <p>The Sales owner edited the booking after sending it. What you see is the latest version, not the one sent. Wait until they send it again with &quot;Send change&quot;; approving is not possible until then.</p>
    </Notice>
  );
}

interface CompareRow {
  label: string;
  before: string;
  after: string;
  numeric?: boolean;
  /** A fact of the request itself (no "before" value): never marked as changed. */
  quiet?: boolean;
}

function CompareTable({ rows, beforeNo, afterNo }: { rows: CompareRow[]; beforeNo: number; afterNo: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line bg-canvas p-3 text-sm">
      <div aria-hidden="true" className="hidden gap-2 font-semibold text-quiet sm:grid sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
        <span />
        <span>Confirmed now (version {beforeNo})</span>
        <span>After the change (version {afterNo})</span>
      </div>
      <dl className="m-0 grid gap-2 sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
        {rows.map((row) => (
          <Compare key={row.label} row={row} beforeNo={beforeNo} afterNo={afterNo} />
        ))}
      </dl>
    </div>
  );
}

function Compare({ row, beforeNo, afterNo }: { row: CompareRow; beforeNo: number; afterNo: number }) {
  const changed = !row.quiet && row.before !== row.after;
  const num = row.numeric ? 'tabular-nums' : '';
  return (
    <>
      <dt className="font-medium text-ink">{row.label}</dt>
      <dd className={`m-0 text-copy ${num}`}>
        <span className="text-quiet sm:sr-only">Version {beforeNo}: </span>
        {row.before}
      </dd>
      <dd className={`m-0 flex flex-wrap items-center gap-1.5 text-ink ${num} ${changed ? 'rounded-chip bg-status-warning-tint px-1.5' : ''}`}>
        <span className="text-quiet sm:sr-only">Version {afterNo}: </span>
        {row.after}
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
  // Changed lines first; within a changed service the lines that stay the same follow them.
  const lines = row.state === 'same' ? [] : [...row.lines.filter((l) => l.changed), ...row.lines.filter((l) => !l.changed)];
  return (
    <article aria-label={`Service ${row.itemNo}: ${row.serviceTitle}`} className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 font-semibold wrap-anywhere text-ink">
          {row.itemNo}. {row.serviceTitle}
        </p>
        <StatusBadge tone={w.tone}>{w.word}</StatusBadge>
      </div>
      {lines.length === 0 ? null : (
        <dl className="m-0 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,12rem)_1fr_1fr]">
          {lines.map((l) => (
            <ServiceLine key={l.key} line={l} />
          ))}
        </dl>
      )}
    </article>
  );
}

function ServiceLine({ line: l }: { line: ReviewLine }) {
  return (
    <div className="contents">
      <dt className="text-quiet">{l.label}</dt>
      <dd className="m-0 wrap-anywhere text-copy">
        <span className="text-quiet sm:sr-only">Now: </span>
        {valueText(l.before)}
      </dd>
      <dd className={`m-0 flex flex-wrap items-center gap-1.5 wrap-anywhere text-ink ${l.changed ? 'rounded-chip bg-status-warning-tint px-1.5' : ''}`}>
        <span className="text-quiet sm:sr-only">After: </span>
        {valueText(l.after)}
        {l.changed ? <StatusBadge tone="warning">Changed</StatusBadge> : null}
      </dd>
    </div>
  );
}

const ISO_DAY = /\b(\d{4}-\d{2}-\d{2})(?![T\d:])/g;

/** A fact value with any plain day ("2026-12-12") written the usual way ("12 Dec 2026"). */
export function valueText(value: string | null): string {
  if (value === null) return '—';
  return value.replace(ISO_DAY, (day) => dayText(day));
}

function tripText(s: ReviewSideView): string {
  if (!s.tripStart && !s.tripEnd) return '—';
  return `${dayText(s.tripStart)} to ${dayText(s.tripEnd)}`;
}

function planText(s: ReviewSideView): string {
  return s.plan.map((i) => `${i.seq}|${i.amountPaise}|${i.dueDate ?? ''}|${i.label ?? ''}`).join(';');
}
