import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusPill, type StatusTone } from '@/components/StatusPill';
import { formatPaise } from '@/modules/deals/dto';
import {
  BOOKING_STATUS_LABEL,
  type BookingActionResult,
  type BookingIssueCode,
  type BookingPanelState,
  type BookingPanelView,
  ERROR_TEXT,
  EVIDENCE_KIND_LABEL,
  type EvidenceItemView,
  type EvidenceStatus,
  ISSUE_TEXT,
  PROOF_HIDDEN_TEXT,
  PURCHASE_TASK_STATUS_LABEL,
} from '@/modules/fulfilment/contracts';
import {
  BookingDraftEditor,
  BookingStatusAnnouncer,
  ConfirmBookingForm,
  OpenBookingDraftForm,
  RemoveEvidenceForm,
  UploadEvidenceForm,
} from './booking-forms';
import { BOOKING_TOTAL_LABEL, FIELD_ID, ISSUE_FIELD, PURCHASE_BUDGET_LABEL } from './booking-fields';
import { HandoffTrack, type HandoffStep, WhoActs } from './handoff';
import { formatIst } from './deal-labels';
import { HiddenForRole, NotRecorded, OrNotRecorded } from './value-states';

const PILL: Record<BookingPanelState, { tone: StatusTone; glyph: string }> = {
  none: { tone: 'neutral', glyph: '○' },
  draft_needs_repair: { tone: 'warn', glyph: '!' },
  draft_ready: { tone: 'info', glyph: '✓' },
  confirmed: { tone: 'ok', glyph: '✓' },
};

type GateIssue = 'booking_disabled' | 'environment_unset';
const GATE_ISSUES: GateIssue[] = ['booking_disabled', 'environment_unset'];

export const PROOF_PRIVACY_TEXT =
  'Proof files are visible only to the Sales owner, assigned Sales and the branch Sales Manager — never to Purchase.';
export const INTERNAL_TASK_TEXT = 'Internal task — the hotel is not booked yet.';

const EVIDENCE_STATUS_TEXT: Record<EvidenceStatus, string> = {
  stored: 'Stored',
  pending_upload: 'Upload did not finish',
  failed: 'Upload failed',
  removed: 'Removed',
};
const EVIDENCE_GLYPH: Record<EvidenceStatus, string> = { stored: '✓', pending_upload: '!', failed: '✕', removed: '–' };

function formatDate(iso: string | null): string {
  if (!iso) return 'Not set';
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t)
    ? iso
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(t);
}

export function formatDateOnly(iso: string): string {
  return formatDate(iso);
}

function money(paise: string | null | undefined): string {
  return paise ? formatPaise(paise) : 'Not set';
}

/** Preview-gallery-only overrides (initial action results, dialog open). */
export interface BookingPanelPreview {
  openState?: BookingActionResult<unknown>;
  saveState?: BookingActionResult<unknown>;
  confirmState?: BookingActionResult<unknown>;
  uploadState?: BookingActionResult<unknown>;
  confirmOpen?: boolean;
}

export function HotelBookingPanel({ booking, preview }: { booking: BookingPanelView; preview?: BookingPanelPreview }) {
  const { state, issues } = booking;
  const gateIssue: GateIssue | undefined = GATE_ISSUES.find((code) => issues.includes(code));
  const isDraft = state === 'draft_needs_repair' || state === 'draft_ready';
  const confirmAvailable = state === 'draft_ready' && booking.canConfirm && !gateIssue;
  // Editors who may not confirm (for example a Sales assignee who is not the owner).
  const notConfirmer = isDraft && booking.canEdit && booking.confirmBlockedReason === ERROR_TEXT.not_authorized;

  // One "Next:" line (copy G-18): lower case after "Next:", the actor after a dot.
  const confirmers = 'the deal owner or a Sales Manager for this branch';
  let who: ReactNode = null;
  let next: string;
  if (state === 'confirmed') {
    if (booking.confirmed?.taskStatus === 'supplier_confirmed') {
      next = 'Nothing waiting. Purchase recorded the supplier’s confirmation of the hotel.';
    } else {
      who = <WhoActs roles={['Purchase']}>{booking.confirmed?.taskAssigneeName ?? 'Purchase team'}</WhoActs>;
      next = 'Purchase arranges the hotel. Nothing has been booked with the hotel yet.';
    }
  } else if (state === 'none' && booking.openBlockedReason) {
    // Stage 7 / DA-29a: the Deal is lost or rejected in Bitrix; nobody can start a booking now.
    next = 'nothing while the deal is lost or rejected in Bitrix';
  } else if (state === 'none') {
    if (booking.canEdit) who = <WhoActs roles={['Sales']}>You</WhoActs>;
    next = booking.canEdit ? 'add the hotel details and upload the customer’s acceptance proof' : `${confirmers} adds the hotel details`;
  } else if (gateIssue) {
    who = <WhoActs roles={['Admin']}>An admin</WhoActs>;
    next = `${ISSUE_TEXT[gateIssue]} Your draft is saved.`;
  } else if (state === 'draft_needs_repair') {
    if (booking.canEdit) who = <WhoActs roles={['Sales']}>You</WhoActs>;
    next = !booking.canEdit
      ? 'the deal owner, assigned Sales or a Sales Manager for this branch fixes the items listed below'
      : notConfirmer
        ? `fix the items listed below; ${confirmers} then confirms`
        : 'fix the items listed below, then confirm';
  } else if (booking.canConfirm) {
    who = <WhoActs roles={['Sales', 'Sales Manager']}>You</WhoActs>;
    next = 'review the details and confirm to create the Purchase task';
  } else {
    next = `${confirmers} reviews the details and confirms`;
  }

  const pill = PILL[state];
  const versionNo = booking.versionNo;
  return (
    <section className="work-panel" aria-labelledby="booking-heading" id="hotel-booking">
      <div className="work-panel-head">
        <div>
          <span className="eyebrow">Hotel booking{versionNo ? ` · version ${versionNo}` : ''}</span>
          <h2 id="booking-heading" tabIndex={-1}>
            Hotel booking
          </h2>
          <StatusPill tone={pill.tone} glyph={pill.glyph} label="Booking status:">
            {BOOKING_STATUS_LABEL[state]}
          </StatusPill>
          <p className="next-line" data-slot="next-line">
            <strong>Next:</strong> {next}
            {who ? <> · {who}</> : null}
          </p>
        </div>
        {state === 'none' && booking.openBlockedReason ? (
          <div className="primary-slot">
            <p className="note info mb-0" role="note">
              {booking.openBlockedReason}
            </p>
          </div>
        ) : null}
        {state === 'none' && booking.canEdit && !booking.openBlockedReason ? (
          <OpenBookingDraftForm dealId={booking.dealId} initialState={preview?.openState} />
        ) : null}
        {state === 'confirmed' && booking.confirmed ? (
          <div className="primary-slot">
            <Link className="button" href={`/app/purchase/${booking.confirmed.taskId}`}>
              View Purchase task
            </Link>
          </div>
        ) : null}
        {confirmAvailable && booking.versionId && booking.versionNo ? (
          <div className="primary-slot">
            <ConfirmBookingForm
              dealId={booking.dealId}
              versionId={booking.versionId}
              versionNo={booking.versionNo}
              contentHash={booking.contentHash ?? ''}
              initialState={preview?.confirmState}
              defaultOpen={preview?.confirmOpen}
            />
          </div>
        ) : null}
        {notConfirmer ? (
          <div className="primary-slot">
            <p className="note info mb-0">{ERROR_TEXT.not_authorized}</p>
          </div>
        ) : null}
      </div>
      <div className="work-panel-body">
        <HandoffTrack label="Booking hand-offs" steps={bookingHandoff(booking, gateIssue)} />
        <BookingStatusAnnouncer dealId={booking.dealId} confirmed={state === 'confirmed'} />
        {gateIssue && isDraft ? (
          <div className="note warn" role="note">
            <p>
              <strong>Confirmation is blocked.</strong> {ERROR_TEXT[gateIssue]}
            </p>
          </div>
        ) : null}
        {isDraft && !booking.canEdit ? (
          <p className="note info">
            You can read this draft. The deal owner, a Sales assignee or a Sales Manager for this branch can change it.
          </p>
        ) : null}
        {state === 'confirmed' ? <ConfirmedBooking booking={booking} /> : null}
        {isDraft ? (
          <RepairList issues={issues} hasSellingField={booking.sellingTotalPaise !== undefined} editable={booking.canEdit} />
        ) : null}
        {isDraft && booking.canEdit && booking.versionId && booking.versionNo && booking.rowVersion !== null ? (
          <section>
            <BookingDraftEditor
              dealId={booking.dealId}
              versionId={booking.versionId}
              versionNo={booking.versionNo}
              rowVersion={booking.rowVersion}
              contentHash={booking.contentHash}
              facts={booking.facts}
              {...(booking.sellingTotalPaise !== undefined ? { sellingTotalPaise: booking.sellingTotalPaise } : {})}
              issues={issues}
              confirmAvailable={confirmAvailable}
              initialSaveState={preview?.saveState}
            />
          </section>
        ) : null}
        {isDraft && !booking.canEdit ? <BookingFactsList booking={booking} /> : null}
        {state !== 'none' ? (
          <ProofSection booking={booking} uploadState={preview?.uploadState} editable={isDraft && booking.canEdit} />
        ) : null}
      </div>
    </section>
  );
}

/** Sales → confirmer → Purchase, with the current step marked (and "blocked" when the gate is off). */
export function bookingHandoff(booking: BookingPanelView, gateIssue?: GateIssue): HandoffStep[] {
  const { state } = booking;
  const confirmed = state === 'confirmed';
  const otherIssues = booking.issues.filter((code) => !GATE_ISSUES.includes(code as GateIssue));
  const salesDone = confirmed || (state !== 'none' && otherIssues.length === 0);
  const task = booking.confirmed;
  return [
    {
      roles: ['Sales'],
      label: 'Add hotel details and customer proof',
      // Stage 7: a lost or rejected Deal cannot start a booking.
      state: salesDone ? 'done' : booking.openBlockedReason ? 'blocked' : 'now',
      detail: !salesDone && booking.openBlockedReason ? 'The deal is lost or rejected in Bitrix.' : undefined,
    },
    {
      roles: ['Sales', 'Sales Manager'],
      label: 'Confirm and create the Purchase task',
      state: confirmed ? 'done' : gateIssue && salesDone ? 'blocked' : salesDone ? 'now' : 'later',
      detail: confirmed
        ? undefined
        : gateIssue && salesDone
          ? 'Waiting for an admin: booking confirmation is turned off here.'
          : 'Deal owner or the branch Sales Manager.',
    },
    {
      roles: ['Purchase'],
      label: 'Take the task and arrange the hotel',
      state: confirmed ? 'now' : 'later',
      detail: task ? (task.taskAssigneeName ? `Taken by ${task.taskAssigneeName}.` : 'Not taken yet.') : undefined,
    },
  ];
}

function RepairList({
  issues,
  hasSellingField,
  editable,
}: {
  issues: BookingIssueCode[];
  hasSellingField: boolean;
  /** Read-only viewers get plain text: the fields are not on their page. */
  editable: boolean;
}) {
  return (
    <section aria-labelledby="repair-heading">
      <h3 id="repair-heading">Before you can confirm</h3>
      {issues.length === 0 ? (
        <p className="mb-0">
          <span aria-hidden="true">✓ </span>Nothing is missing.
        </p>
      ) : (
        <ol className="repair-list">
          {issues.map((code) => {
            const target = ISSUE_FIELD[code];
            const linkable = editable && target && (target !== 'sellingTotalRupees' || hasSellingField);
            return (
              <li key={code}>
                {linkable ? <a href={`#${FIELD_ID[target]}`}>{ISSUE_TEXT[code]}</a> : ISSUE_TEXT[code]}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The booking total, or why it is absent (not recorded vs hidden for this viewer). */
export function BookingTotalValue({ sellingTotalPaise }: { sellingTotalPaise: string | null | undefined }) {
  if (sellingTotalPaise === undefined) return <HiddenForRole hint="The deal owner or a Sales Manager can see it." />;
  if (sellingTotalPaise === null) return <NotRecorded />;
  return <>{formatPaise(sellingTotalPaise)}</>;
}

function BookingFactsList({ booking }: { booking: BookingPanelView }) {
  const f = booking.facts;
  return (
    <div className="fact-sections">
      <section aria-labelledby="facts-stay">
        <h3 id="facts-stay">Stay</h3>
        <dl className="facts">
          <dt>Hotel</dt>
          <dd>
            <OrNotRecorded value={f?.hotelName} />
          </dd>
          <dt>City</dt>
          <dd>
            <OrNotRecorded value={f?.city} />
          </dd>
          <dt>Check-in</dt>
          <dd>{f?.checkIn ? formatDate(f.checkIn) : <NotRecorded />}</dd>
          <dt>Check-out</dt>
          <dd>{f?.checkOut ? formatDate(f.checkOut) : <NotRecorded />}</dd>
        </dl>
      </section>
      <section aria-labelledby="facts-rooms">
        <h3 id="facts-rooms">Rooms and travellers</h3>
        <dl className="facts">
          <dt>Rooms</dt>
          <dd>
            <OrNotRecorded value={f?.rooms} />
          </dd>
          <dt>Room type</dt>
          <dd>
            <OrNotRecorded value={f?.roomType} />
          </dd>
          <dt>Meal plan</dt>
          <dd>
            <OrNotRecorded value={f?.mealPlan} />
          </dd>
          <dt>Adults</dt>
          <dd>
            <OrNotRecorded value={f?.adults} />
          </dd>
          <dt>Children</dt>
          <dd>{f?.children ?? 0}</dd>
        </dl>
      </section>
      <section aria-labelledby="facts-money">
        <h3 id="facts-money">Money for this booking</h3>
        <dl className="facts">
          <dt>{PURCHASE_BUDGET_LABEL}</dt>
          <dd>{f?.purchaseBudgetPaise ? money(f.purchaseBudgetPaise) : <NotRecorded />}</dd>
          <dt>{BOOKING_TOTAL_LABEL}</dt>
          <dd>
            <BookingTotalValue sellingTotalPaise={booking.sellingTotalPaise} />
          </dd>
        </dl>
        <p className="hint mt-1 mb-0">The deal selling price is shown separately, under the deal.</p>
      </section>
      <section aria-labelledby="facts-notes">
        <h3 id="facts-notes">Notes for Purchase</h3>
        <dl className="facts">
          <dt>Inclusions</dt>
          <dd className="prewrap">{f?.inclusions ?? 'None'}</dd>
          <dt>Special requests</dt>
          <dd className="prewrap">{f?.specialRequests ?? 'None'}</dd>
        </dl>
      </section>
    </div>
  );
}

function ConfirmedBooking({ booking }: { booking: BookingPanelView }) {
  const c = booking.confirmed;
  return (
    <section aria-labelledby="confirmed-heading">
      <h3 id="confirmed-heading">Confirmed version {booking.versionNo}</h3>
      {c ? (
        <dl className="facts mb-0">
          <dt>Confirmed</dt>
          <dd>
            {formatIst(c.at)} by {c.byName}
          </dd>
          <dt>Purchase task</dt>
          <dd>
            {PURCHASE_TASK_STATUS_LABEL[c.taskStatus]} · {c.taskAssigneeName ? `taken by ${c.taskAssigneeName}` : 'not taken yet'}
          </dd>
        </dl>
      ) : null}
      <p className="note info mt-1">
        {c?.taskStatus === 'supplier_confirmed' ? 'Internal task — supplier confirmed.' : INTERNAL_TASK_TEXT} {ERROR_TEXT.already_confirmed}
      </p>
      <BookingFactsList booking={booking} />
    </section>
  );
}

function ProofSection({
  booking,
  editable,
  uploadState,
}: {
  booking: BookingPanelView;
  editable: boolean;
  uploadState?: BookingActionResult<unknown>;
}) {
  const items = booking.evidence.filter((e) => e.status !== 'removed');
  return (
    <section aria-labelledby={FIELD_ID.proof}>
      <h3 id={FIELD_ID.proof} tabIndex={-1}>
        Proof the customer accepted
      </h3>
      <p className="note accent">{PROOF_PRIVACY_TEXT}</p>
      {!booking.evidenceVisible ? (
        <p>
          <HiddenForRole /> <span className="absent-hint">{PROOF_HIDDEN_TEXT}</span>
        </p>
      ) : items.length === 0 ? (
        <p className="absent not-recorded">
          <span aria-hidden="true">– </span>No proof uploaded yet.
        </p>
      ) : (
        <ul className="file-list" aria-label="Proof files">
          {items.map((item) => (
            <EvidenceRow key={item.id} item={item} dealId={booking.dealId} editable={editable} />
          ))}
        </ul>
      )}
      {editable && booking.versionId ? (
        <UploadEvidenceForm
          dealId={booking.dealId}
          versionId={booking.versionId}
          fileCount={items.length}
          initialState={uploadState}
        />
      ) : null}
    </section>
  );
}

function EvidenceRow({ item, dealId, editable }: { item: EvidenceItemView; dealId: string; editable: boolean }) {
  const problem = item.status === 'failed' || item.status === 'pending_upload';
  return (
    <li className={`file-row ${item.status === 'stored' ? 'is-stored' : ''} ${problem ? 'is-problem' : ''}`}>
      <span className="file-glyph" aria-hidden="true">
        {EVIDENCE_GLYPH[item.status]}
      </span>
      <div>
        <div className="file-name">{item.fileName}</div>
        <div className="file-meta">
          {EVIDENCE_KIND_LABEL[item.kind]} · {item.sizeLabel} · {EVIDENCE_STATUS_TEXT[item.status]}
          {item.uploadedByYou ? ' · uploaded by you' : ''} · {formatIst(item.uploadedAt)}
          {problem ? '. Remove it or upload it again.' : ''}
        </div>
      </div>
      <div className="file-actions">
        {item.status === 'stored' ? (
          <a className="button secondary small" href={`/app/bookings/evidence/${item.id}`} rel="noopener">
            Download<span className="visually-hidden"> {item.fileName}</span>
          </a>
        ) : null}
        {editable ? <RemoveEvidenceForm dealId={dealId} evidenceId={item.id} fileName={item.fileName} /> : null}
      </div>
    </li>
  );
}

// The deal page's "could not load" state moved to the deal page module (screen group 4).
export { HotelBookingUnavailable } from './deal-page-view';
