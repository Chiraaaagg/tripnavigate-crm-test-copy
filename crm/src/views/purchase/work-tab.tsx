import { Ban, CircleCheck, CircleDot, FileCheck2, Hourglass, Mail, MinusCircle, PlayCircle, RotateCcw, TriangleAlert, HandCoins } from 'lucide-react';
import type React from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { formatPaise } from '@/modules/deals/dto';
import {
  A1_TEXT,
  CANCELLATION_STATUS_LABEL,
  PROCUREMENT_ISSUE_TEXT,
  PURCHASE_BUILD_TEXT,
  PURCHASE_EVIDENCE_KIND_LABEL,
  SUPPLIER_EMAIL_KIND_LABEL,
  SUPPLIER_EMAIL_STATUS_LABEL,
  type CostVersionView,
  type PurchaseWorkspaceView,
  type QuoteView,
  type SupplierEmailView,
} from '@/modules/procurement/contracts';
import { latestCostVersionNo } from '@/modules/procurement/dto';
import {
  HOLD_REASON_TEXT,
  PAYMENT_PART_LABEL,
  PAYMENT_STATUS_HELP,
  PAYMENT_STATUS_LABEL,
  SUPPLIER_MONEY_ERROR_TEXT,
  type PaymentContextView,
  type PurchasePaymentRequestView,
  type SupplierPaymentStatus,
} from '@/modules/supplier-money/contracts';
import { formatDateOnly } from '../booking-views';
import { budgetText } from '../department/task-frame';
import {
  ApproveOverBudgetForm,
  ConfirmSupplierForm,
  ReassignTaskForm,
  ReleaseTaskForm,
  RemovePurchaseFileForm,
  UploadPurchaseFileForm,
  WithdrawQuoteForm,
  type ProcUiResult,
} from '../procurement-forms';
import { formatIst } from '../staff-views';
import { UnavailableAction, type DecisionAction } from '../accounts/supplier-forms';
import { SupplierEmailDrawer } from './email-drawer';
import { WorkFlashProvider } from './work-flash';
import { GO_AHEAD_HELP, GoAheadBadge } from './go-ahead';
import { budgetDelta, budgetDeltaText, lowestPaise, type BudgetDelta } from './purchase-vm';
import { BookedFacts } from './what-sales-booked';
import { CancellationChargeForm, OnePressForm, PaymentRequestDrawer, UseFinalRateForm, AddRateForm } from './work-forms';

/*
 * Purchase Work tab (prototype 1 Nov 2026, round 2). Order: the service as
 * Sales booked it, Rate negotiation (summary line, one compact tile per rate,
 * "Add rate"), the trip-cancellation card when the Manager cancelled the
 * trip, Supplier payments, Purchase files, hand back / reassign. The final
 * tile carries the one primary action: "Send booking request", then (after
 * the Accounts go-ahead for a hotel) "Record supplier confirmation". Each
 * unavailable action stays visible and focusable with one short reason.
 * Purchase never sees a selling price, receipts or company funding amounts.
 */

/** Server actions for the Work tab. The route passes the real ones; the preview gallery passes stubs. */
export interface PurchaseWorkActions {
  addRate: DecisionAction;
  useFinalRate: DecisionAction;
  rateRequest: DecisionAction;
  bookingRequest: DecisionAction;
  cancellationCharge: DecisionAction;
  sendCharges: DecisionAction;
  createPayment: DecisionAction;
  resubmitPayment: DecisionAction;
  cancelPayment: DecisionAction;
  uploadSupplierFile: DecisionAction;
  /** Preview only: a stub for the confirmation dialog (same signature as confirmSupplierAction). */
  confirmSupplier?: Parameters<typeof ConfirmSupplierForm>[0]['action'];
}

const metaClass = 'm-0 text-sm text-quiet';

function WorkCard({ id, title, description, actions, children }: { id: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader className="max-sm:flex-col max-sm:items-start">
          <div className="min-w-0">
            <CardTitle id={id}>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {actions}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

function DeltaBadge({ delta }: { delta: BudgetDelta }) {
  if (delta.kind === 'no_budget') return null;
  const over = delta.kind === 'over';
  return (
    <StatusBadge tone={over ? 'warning' : 'success'} icon={over ? TriangleAlert : CircleCheck} wrap>
      <span className="sr-only">Budget: </span>
      {budgetDeltaText(delta)}
    </StatusBadge>
  );
}

function byNames(c: { createdByName: string | null }, viewerIsAssignee: boolean, isMine: boolean): string {
  if (isMine && viewerIsAssignee) return 'you';
  return c.createdByName ?? 'a Purchase colleague';
}

// ---------------------------------------------------------------------------
// Next line (header)
// ---------------------------------------------------------------------------

/** The "Next:" text from the workspace (lower case after "Next:"). */
export function purchaseNextText(ws: PurchaseWorkspaceView): string {
  const t = ws.task;
  if (t.status === 'supplier_confirmed') return 'Nothing waiting.';
  if (ws.cancellation) return ws.canWork || ws.cancellation.canEnter ? 'enter what the supplier keeps and refunds' : 'Purchase enters the supplier’s cancellation charges';
  if (!t.assignedToYou) return t.assigneeName ? `${t.assigneeName} works on this task` : t.canClaim ? 'take this task' : 'Purchase takes this task';
  const latestNo = latestCostVersionNo(ws);
  if (ws.quotes.filter((q) => q.status !== 'withdrawn').length === 0) return 'ask the supplier for rates, then add each rate you get';
  if (latestNo === 0) return 'choose the final rate';
  if (ws.issues.includes('over_budget')) return 'wait for the branch Manager to approve the final rate above budget';
  if (ws.issues.includes('booking_request_not_sent')) return 'send the booking request from the final rate, then record the supplier’s confirmation';
  if (ws.goAhead.state === 'pending') return 'wait for Accounts to give the go-ahead, then record the supplier’s confirmation';
  if (ws.goAhead.state === 'returned' || ws.goAhead.state === 'stale') return 'send the booking request again';
  return 'record the supplier’s confirmation';
}

// ---------------------------------------------------------------------------
// Rate negotiation
// ---------------------------------------------------------------------------

function bookingRequestFor(ws: PurchaseWorkspaceView, versionNo: number): SupplierEmailView | null {
  return ws.emails.find((e) => e.kind === 'booking_request' && e.costVersionNo === versionNo && !e.failed) ?? null;
}

function FinalTileActions({ ws, latest, quote, actions, senderName, confirmState }: { ws: PurchaseWorkspaceView; latest: CostVersionView; quote: QuoteView; actions: PurchaseWorkActions; senderName: string; confirmState?: ProcUiResult | null }) {
  const T = PURCHASE_BUILD_TEXT;
  const hotel = ws.task.serviceType === 'hotel';
  const overBudget = BigInt(latest.amountPaise) > BigInt(ws.task.purchaseBudgetPaise || '0') && BigInt(ws.task.purchaseBudgetPaise || '0') > 0n;
  const waitingManager = overBudget && !latest.overBudgetApprovedAt;
  const sent = bookingRequestFor(ws, latest.versionNo);
  const goAhead = ws.goAhead.state;
  const drawer = (label: string, variant: 'primary' | 'secondary') => (
    <SupplierEmailDrawer
      kind="booking_request"
      taskId={ws.task.taskId}
      dealReference={ws.task.dealReference}
      task={ws.task}
      suppliers={ws.supplierChoices.filter((s) => s.supplierId === quote.supplierId).length > 0 ? ws.supplierChoices.filter((s) => s.supplierId === quote.supplierId) : [{ supplierId: quote.supplierId, name: quote.supplierName, verificationStatus: quote.supplierVerification, email: null }]}
      supplierId={quote.supplierId}
      senderName={senderName}
      amountPaise={latest.amountPaise}
      offerRoomType={quote.roomType}
      offerMealPlan={quote.mealPlan}
      expectedVersionNo={latest.versionNo}
      sendingEnabled={ws.emailSendingEnabled}
      action={actions.bookingRequest}
      triggerLabel={label}
      triggerVariant={variant}
    />
  );
  const parts: React.ReactNode[] = [];
  if (waitingManager) {
    parts.push(
      <Notice key="mgr" tone="warning" title="Above the approved budget">
        <p>The branch Manager must approve this final rate before the booking request.</p>
        {ws.canApproveOverBudget ? <ApproveOverBudgetForm taskId={ws.task.taskId} versionNo={latest.versionNo} /> : null}
      </Notice>,
    );
  } else if (latest.overBudgetApprovedAt) {
    parts.push(
      <p key="mgr-ok" className={metaClass}>
        Approved above budget{latest.overBudgetApprovedByName ? ` by ${latest.overBudgetApprovedByName}` : ''} · {formatIst(latest.overBudgetApprovedAt)}
      </p>,
    );
  }
  if (!ws.canWork) return parts.length > 0 ? <>{parts}</> : null;
  if (ws.cancellation) {
    parts.push(<UnavailableAction key="cx" label={T.bookingRequestLabel} reason={PROCUREMENT_ISSUE_TEXT.trip_cancelled} />);
    return <>{parts}</>;
  }
  if (waitingManager) {
    parts.push(<UnavailableAction key="wait" label={T.bookingRequestLabel} reason="Waiting for the branch Manager to approve this rate above budget." />);
    return <>{parts}</>;
  }
  if (!sent) {
    parts.push(<div key="send">{drawer(T.bookingRequestLabel, 'primary')}</div>);
    return <>{parts}</>;
  }
  parts.push(
    <p key="sent" className={metaClass}>
      <Mail aria-hidden="true" className="mr-1 inline size-3.5 align-[-2px]" />
      Booking request {sent.status === 'marked_sent' ? 'marked as sent' : SUPPLIER_EMAIL_STATUS_LABEL[sent.status].toLowerCase()} · {formatIst(sent.sentAt)}
      {sent.sentByName ? ` by ${sent.sentByName}` : ''}
    </p>,
  );
  if (hotel && (goAhead === 'returned' || goAhead === 'stale')) {
    parts.push(
      <Notice key="ga" tone={goAhead === 'returned' ? 'danger' : 'warning'} title={goAhead === 'returned' ? 'Accounts returned the go-ahead' : 'The go-ahead is out of date'}>
        <p>{ws.goAhead.returnReason && goAhead === 'returned' ? ws.goAhead.returnReason : GO_AHEAD_HELP[goAhead]}</p>
      </Notice>,
      <div key="again">{drawer(T.bookingRequestAgainLabel, 'primary')}</div>,
    );
    return <>{parts}</>;
  }
  const blockers = ws.issues.filter((i) => i !== 'booking_request_not_sent');
  if (hotel && goAhead === 'pending') {
    parts.push(<UnavailableAction key="conf" label="Record supplier confirmation" reason="Waiting for Accounts go-ahead. Accounts approves every hotel commitment." />);
  } else {
    parts.push(
      <div key="conf" data-slot="work-primary">
        <ConfirmSupplierForm taskId={ws.task.taskId} latestVersionNo={latest.versionNo} issues={blockers} initialState={confirmState ?? null} action={actions.confirmSupplier} />
        {blockers.length > 0 ? (
          <ul className="m-0 mt-2.5 flex list-disc flex-col gap-1 pl-5 text-sm text-quiet" aria-label="Still needed before the confirmation">
            {blockers.map((code) => (
              <li key={code}>{PROCUREMENT_ISSUE_TEXT[code]}</li>
            ))}
          </ul>
        ) : null}
      </div>,
    );
  }
  parts.push(<div key="again">{drawer(T.bookingRequestAgainLabel, 'secondary')}</div>);
  return <>{parts}</>;
}

function RateTile({
  ws,
  quote,
  final,
  latest,
  actions,
  senderName,
  confirmState,
}: {
  ws: PurchaseWorkspaceView;
  quote: QuoteView;
  final: boolean;
  latest: CostVersionView | null;
  actions: PurchaseWorkActions;
  senderName: string;
  confirmState?: ProcUiResult | null;
}) {
  const confirmed = ws.task.status === 'supplier_confirmed';
  const withdrawn = quote.status === 'withdrawn';
  const amount = final && latest ? latest.amountPaise : quote.quotedCostPaise;
  const delta = budgetDelta(amount, ws.task.purchaseBudgetPaise);
  const latestNo = latest?.versionNo ?? 0;
  const mine = ws.task.assignedToYou;
  return (
    <li
      className={cn(
        'm-0 flex min-w-0 flex-col gap-2 rounded-control border px-3.5 py-3',
        final ? 'border-brand-line bg-brand-tint/40' : withdrawn ? 'border-dashed border-line bg-wash' : 'border-line bg-canvas',
      )}
      aria-label={`${quote.supplierName}${final ? ', final rate' : withdrawn ? ', withdrawn' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="m-0 min-w-0 text-base font-semibold wrap-anywhere text-ink">{quote.supplierName}</h4>
        {final ? (
          <StatusBadge tone={confirmed ? 'success' : 'brand'} icon={confirmed ? CircleCheck : CircleDot}>
            <span className="sr-only">Rate: </span>
            {confirmed ? 'Final rate · confirmed' : 'Final rate'}
          </StatusBadge>
        ) : withdrawn ? (
          <StatusBadge tone="neutral" icon={MinusCircle}>
            <span className="sr-only">Rate: </span>Withdrawn
          </StatusBadge>
        ) : null}
      </div>
      <p className="m-0 text-lg font-semibold text-ink tabular-nums">{formatPaise(amount)}</p>
      {final && latest && latest.amountPaise !== quote.quotedCostPaise ? <p className={metaClass}>The supplier first gave {formatPaise(quote.quotedCostPaise)}.</p> : null}
      {quote.perRoomNightPaise ? <p className={metaClass}>{formatPaise(quote.perRoomNightPaise)} per room per night</p> : null}
      {withdrawn ? null : (
        <div>
          <DeltaBadge delta={delta} />
        </div>
      )}
      {quote.note ? <p className="m-0 text-sm whitespace-pre-wrap wrap-break-word text-copy">{quote.note}</p> : null}
      <p className={metaClass}>
        Added by {byNames(quote, mine, quote.createdByName === ws.task.assigneeName)} · {formatIst(quote.createdAt)}
      </p>
      {final && latest ? (
        <div className="mt-1.5 flex flex-col items-start gap-2">
          <FinalTileActions ws={ws} latest={latest} quote={quote} actions={actions} senderName={senderName} confirmState={confirmState} />
        </div>
      ) : ws.canWork && !confirmed && !withdrawn && !ws.cancellation ? (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          <UseFinalRateForm taskId={ws.task.taskId} quoteId={quote.quoteId} amountPaise={quote.quotedCostPaise} latestVersionNo={latestNo} supplierName={quote.supplierName} action={actions.useFinalRate} />
          <WithdrawQuoteForm taskId={ws.task.taskId} quoteId={quote.quoteId} label={quote.supplierName} />
        </div>
      ) : null}
    </li>
  );
}

function SentEmails({ emails }: { emails: SupplierEmailView[] }) {
  if (emails.length === 0) return null;
  return (
    <details className="rounded-control border border-line bg-canvas px-3.5 py-2.5">
      <summary className={cn('cursor-pointer rounded-chip font-medium text-ink', focusRing)}>E-mails to the supplier ({emails.length})</summary>
      <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0" aria-label="E-mails to the supplier, newest first">
        {emails.map((e) => (
          <li key={e.emailId} className="m-0 flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0">
            <p className="m-0 flex flex-wrap items-center gap-2 font-medium text-ink">
              {SUPPLIER_EMAIL_KIND_LABEL[e.kind]} · {e.supplierName}
              <StatusBadge tone={e.failed ? 'danger' : e.status === 'queued' ? 'info' : 'success'} icon={e.failed ? Ban : e.status === 'queued' ? Hourglass : CircleCheck}>
                <span className="sr-only">E-mail: </span>
                {SUPPLIER_EMAIL_STATUS_LABEL[e.status]}
              </StatusBadge>
            </p>
            <p className={metaClass}>
              To {e.toEmail}
              {e.ccEmails.length > 0 ? ` · Cc ${e.ccEmails.join(', ')}` : ''} · {formatIst(e.sentAt)}
              {e.sentByName ? ` by ${e.sentByName}` : ''}
            </p>
            {e.failed ? <p className="m-0 text-sm text-status-danger">{PURCHASE_BUILD_TEXT.emailSendFailed}</p> : null}
            <details>
              <summary className={cn('cursor-pointer rounded-chip text-sm text-brand-strong', focusRing)}>View e-mail</summary>
              <p className="m-0 mt-1.5 text-sm font-medium text-ink wrap-anywhere">{e.subject}</p>
              <pre className="m-0 mt-1.5 max-w-full font-sans text-sm whitespace-pre-wrap wrap-break-word text-copy">{e.body}</pre>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RateNegotiationCard({ ws, actions, senderName, confirmState }: { ws: PurchaseWorkspaceView; actions: PurchaseWorkActions; senderName: string; confirmState?: ProcUiResult | null }) {
  const latestNo = latestCostVersionNo(ws);
  const latest = ws.costVersions.find((c) => c.versionNo === latestNo) ?? null;
  const finalQuote = latest ? (ws.quotes.find((q) => q.quoteId === latest.quoteId) ?? null) : null;
  const live = ws.quotes.filter((q) => q.status !== 'withdrawn');
  const lowest = lowestPaise(live.map((q) => q.quotedCostPaise));
  const lowestQuote = lowest ? live.find((q) => q.quotedCostPaise === lowest) : null;
  // Newest last, like a conversation; the final tile keeps its place.
  const tiles = [...ws.quotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const confirmed = ws.task.status === 'supplier_confirmed';
  const hotel = ws.task.serviceType === 'hotel';
  const askButton =
    ws.canWork && !confirmed ? (
      ws.cancellation ? (
        <UnavailableAction label={PURCHASE_BUILD_TEXT.rateRequestLabel} reason={PROCUREMENT_ISSUE_TEXT.trip_cancelled} />
      ) : (
        <SupplierEmailDrawer
          kind="rate_request"
          taskId={ws.task.taskId}
          dealReference={ws.task.dealReference}
          task={ws.task}
          suppliers={ws.supplierChoices}
          supplierId={finalQuote?.supplierId ?? ws.supplierChoices[0]?.supplierId ?? null}
          senderName={senderName}
          sendingEnabled={ws.emailSendingEnabled}
          action={actions.rateRequest}
          triggerLabel={PURCHASE_BUILD_TEXT.rateRequestLabel}
        />
      )
    ) : null;
  return (
    <WorkCard
      id="work-rates"
      title="Rate negotiation"
      description="Add every rate the supplier gives. Choose one as the final rate, then send the booking request from it. Everything is recorded in History."
    >
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-sm font-medium text-quiet">Budget</dt>
          <dd className="m-0 font-semibold text-ink tabular-nums">{budgetText(ws.task.purchaseBudgetPaise)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-sm font-medium text-quiet">Lowest rate</dt>
          <dd className="m-0 font-semibold text-ink tabular-nums">
            {lowest ? formatPaise(lowest) : <span className="font-normal text-quiet">No rates yet</span>}
            {lowestQuote ? <span className="block text-sm font-normal text-quiet">{lowestQuote.supplierName}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-sm font-medium text-quiet">Final rate</dt>
          <dd className="m-0 font-semibold text-ink tabular-nums">
            {latest ? formatPaise(latest.amountPaise) : <span className="font-normal text-quiet">Not chosen yet</span>}
            {finalQuote ? <span className="block text-sm font-normal text-quiet">{finalQuote.supplierName}</span> : null}
          </dd>
        </div>
      </dl>
      {latest ? (
        <div>
          <DeltaBadge delta={budgetDelta(latest.amountPaise, ws.task.purchaseBudgetPaise)} />
        </div>
      ) : null}
      {hotel && !confirmed ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-copy">
          <GoAheadBadge state={ws.goAhead.state} />
          <span>{GO_AHEAD_HELP[ws.goAhead.state]}</span>
        </p>
      ) : null}
      {askButton ? <div>{askButton}</div> : null}
      {tiles.length === 0 ? (
        <p className="m-0 text-quiet">No rates yet. Ask the supplier for rates, then add each rate you get below.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3" aria-label="Rates from suppliers">
          {tiles.map((q) => (
            <RateTile key={q.quoteId} ws={ws} quote={q} final={!!finalQuote && q.quoteId === finalQuote.quoteId} latest={latest} actions={actions} senderName={senderName} confirmState={confirmState} />
          ))}
        </ul>
      )}
      {ws.canWork && !confirmed && !ws.cancellation ? (
        <section aria-labelledby="work-add-rate" className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 id="work-add-rate" className="m-0 text-base font-semibold text-ink">
            Add a rate
          </h3>
          <AddRateForm
            taskId={ws.task.taskId}
            action={actions.addRate}
            suppliers={ws.supplierChoices}
            serviceName={ws.task.hotelName ?? ws.task.itemTitle}
            rooms={ws.task.rooms}
            nights={ws.task.nights}
            hotel={hotel}
          />
        </section>
      ) : null}
      <SentEmails emails={ws.emails} />
    </WorkCard>
  );
}

// ---------------------------------------------------------------------------
// Supplier payments
// ---------------------------------------------------------------------------

const PAYMENT_LOOK: Record<SupplierPaymentStatus, { tone: StatusTone; icon: typeof CircleCheck }> = {
  pending: { tone: 'warning', icon: Hourglass },
  approved: { tone: 'info', icon: PlayCircle },
  returned: { tone: 'danger', icon: RotateCcw },
  cancelled: { tone: 'neutral', icon: MinusCircle },
  paid: { tone: 'info', icon: HandCoins },
  verified: { tone: 'success', icon: CircleCheck },
};

export function PaymentStatusBadge({ r }: { r: Pick<PurchasePaymentRequestView, 'status' | 'route' | 'onHold' | 'holdReason'> }) {
  if (r.onHold && r.holdReason === 'bank_details_on_hold' && r.status === 'approved') {
    return (
      <StatusBadge tone="warning" icon={Ban} wrap>
        <span className="sr-only">Payment request: </span>Approved · on hold
      </StatusBadge>
    );
  }
  const look = PAYMENT_LOOK[r.status];
  const label = r.status === 'pending' ? (r.route === 'manager' ? 'Waiting for the branch Manager' : 'Waiting for Accounts') : PAYMENT_STATUS_LABEL[r.status];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Payment request: </span>
      {label}
    </StatusBadge>
  );
}

/** One payment request row (Work tab card and the Purchase "Payment requests" page). */
export function PaymentRequestItem({
  r,
  ctx,
  actions,
  showService = false,
  footer,
}: {
  r: PurchasePaymentRequestView;
  ctx?: PaymentContextView | null;
  actions?: Pick<PurchaseWorkActions, 'cancelPayment' | 'resubmitPayment' | 'createPayment' | 'uploadSupplierFile'>;
  showService?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <li className="m-0 flex flex-col gap-1.5 rounded-control border border-line bg-canvas px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="m-0 font-semibold text-ink">
          <span className="whitespace-nowrap">{r.refNo}</span> · <span className="tabular-nums">{formatPaise(r.amountPaise)}</span> · {PAYMENT_PART_LABEL[r.part]}
        </p>
        <PaymentStatusBadge r={r} />
      </div>
      <p className={metaClass}>
        {showService ? `${r.dealReference} · ${r.serviceTitle} · ` : ''}
        {r.supplierName}
        {r.dueDate ? ` · due ${formatDateOnly(r.dueDate)}` : ''} · requested by {r.requestedByName ?? 'Purchase'} on {formatIst(r.requestedAt)}
      </p>
      <p className="m-0 text-sm text-copy">{PAYMENT_STATUS_HELP[r.status]}</p>
      {/* Review F1: only the bank-details hold reaches Purchase; funding is never mentioned. */}
      {r.onHold && r.holdReason === 'bank_details_on_hold' ? <p className="m-0 text-sm text-status-warning">{HOLD_REASON_TEXT.bank_details_on_hold}</p> : null}
      {r.paidOn ? (
        <p className={metaClass}>
          Paid on {formatDateOnly(r.paidOn)}
          {r.bankReference ? ` · reference ${r.bankReference}` : ''}
          {r.verifiedAt ? ` · checked ${formatIst(r.verifiedAt)}` : ''}
        </p>
      ) : null}
      {r.status === 'returned' && r.returnReason ? (
        <Notice tone="danger" title={`Returned${r.decidedByName ? ` by ${r.decidedByName}` : ''}`}>
          <p className="whitespace-pre-wrap wrap-break-word">{r.returnReason}</p>
        </Notice>
      ) : null}
      {r.resubmittedAs ? <p className={metaClass}>Sent again as {r.resubmittedAs}.</p> : null}
      {r.resubmitsRefNo ? <p className={metaClass}>Sends {r.resubmitsRefNo} again.</p> : null}
      {actions && (r.canCancel || (r.canResubmit && ctx)) ? (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          {r.canResubmit && ctx ? (
            <PaymentRequestDrawer
              ctx={ctx}
              triggerLabel="Change and send again"
              triggerVariant="secondary"
              createAction={actions.createPayment}
              resubmitAction={actions.resubmitPayment}
              uploadAction={actions.uploadSupplierFile}
              resubmit={{ paymentId: r.id, refNo: r.refNo, part: r.part, amountPaise: r.amountPaise, dueDate: r.dueDate, note: r.note }}
            />
          ) : null}
          {r.canCancel ? <OnePressForm fields={{ paymentId: r.id, taskId: r.taskId, expectedRowVersion: r.rowVersion }} action={actions.cancelPayment} label="Cancel request" pendingLabel="Cancelling…" formLabel={`Cancel payment request ${r.refNo}`} /> : null}
        </div>
      ) : null}
      {footer}
    </li>
  );
}

/**
 * The database decides who may ask (ctx.canRequest: the assignee), also after
 * the supplier confirmed, when the workspace's canWork is false but balance
 * and full payments become possible.
 */
export function SupplierPaymentsCard({ ctx, actions }: { ctx: PaymentContextView; actions: PurchaseWorkActions }) {
  const confirmed = ctx.taskStatus === 'supplier_confirmed';
  const label = confirmed ? 'Request payment' : 'Request advance payment';
  const blocker = ctx.blockers[0];
  let action: React.ReactNode = null;
  if (ctx.canRequest) {
    action = blocker ? (
      <UnavailableAction label={label} reason={SUPPLIER_MONEY_ERROR_TEXT[blocker]} />
    ) : (
      <PaymentRequestDrawer ctx={ctx} triggerLabel={label} createAction={actions.createPayment} resubmitAction={actions.resubmitPayment} uploadAction={actions.uploadSupplierFile} />
    );
  }
  return (
    <WorkCard
      id="work-payments"
      title="Supplier payments"
      description="Accounts approves up to ₹50,000 for a supplier on a Deal; above that, the branch Manager. Accounts pays and records the bank reference."
    >
      {!ctx.bankDetailsApproved && ctx.supplierName ? (
        <Notice tone="warning" title="Bank details not approved">
          <p>{HOLD_REASON_TEXT.bank_details_on_hold}</p>
        </Notice>
      ) : null}
      {ctx.requests.length === 0 ? (
        <p className="m-0 text-quiet">No payment requests yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Payment requests on this service">
          {ctx.requests.map((r) => (
            <PaymentRequestItem key={r.id} r={r} ctx={ctx} actions={actions} />
          ))}
        </ul>
      )}
      {!confirmed && ctx.canRequest ? <p className="m-0 text-sm text-quiet">You can ask for an advance before the supplier confirms. It does not mark the booking as confirmed.</p> : null}
      {action ? <div>{action}</div> : null}
    </WorkCard>
  );
}

// ---------------------------------------------------------------------------
// Trip cancelled: supplier charges
// ---------------------------------------------------------------------------

export function CancellationCard({ ws, latestCostPaise, actions }: { ws: PurchaseWorkspaceView; latestCostPaise: string | null; actions: PurchaseWorkActions }) {
  const c = ws.cancellation;
  if (!c) return null;
  const T = PURCHASE_BUILD_TEXT;
  const charge = c.myCharge;
  return (
    <WorkCard id="work-cancellation" title="Trip cancelled: supplier charges" description="Enter what this supplier keeps and refunds. The customer side is handled separately; it is not shown here.">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={c.status === 'approved' ? 'success' : c.status === 'sent_to_manager' ? 'info' : 'warning'} icon={c.status === 'approved' ? CircleCheck : c.status === 'sent_to_manager' ? Hourglass : TriangleAlert} wrap>
          <span className="sr-only">Cancellation: </span>
          {CANCELLATION_STATUS_LABEL[c.status]}
        </StatusBadge>
      </div>
      <p className="m-0 text-copy">
        <span className="font-semibold text-ink">Reason from the Manager:</span> <span className="whitespace-pre-wrap wrap-break-word">{c.reason}</span>
      </p>
      <p className={metaClass}>
        Opened {formatIst(c.openedAt)}
        {c.openedByName ? ` by ${c.openedByName}` : ''}
      </p>
      {c.returnReason && c.status !== 'approved' ? (
        <Notice tone="danger" title="The Manager sent the charges back">
          <p className="whitespace-pre-wrap wrap-break-word">{c.returnReason}</p>
        </Notice>
      ) : null}
      {charge ? (
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(9rem,13rem)_1fr]">
          <dt className="text-sm font-medium text-quiet">Agreed cost</dt>
          <dd className="m-0 tabular-nums text-ink">{formatPaise(charge.committedCostPaise)}</dd>
          <dt className="text-sm font-medium text-quiet">Supplier keeps</dt>
          <dd className="m-0 tabular-nums text-ink">{formatPaise(charge.supplierKeepsPaise)}</dd>
          <dt className="text-sm font-medium text-quiet">Supplier refunds</dt>
          <dd className="m-0 tabular-nums text-ink">{formatPaise(charge.supplierRefundPaise)}</dd>
          {charge.note ? (
            <>
              <dt className="text-sm font-medium text-quiet">Note</dt>
              <dd className="m-0 whitespace-pre-wrap wrap-break-word text-ink">{charge.note}</dd>
            </>
          ) : null}
          <dt className="text-sm font-medium text-quiet">Credit note</dt>
          <dd className="m-0 text-ink">{charge.creditNoteEvidenceId ? 'Uploaded' : 'Not uploaded'}</dd>
          <dt className="text-sm font-medium text-quiet">Entered</dt>
          <dd className="m-0 text-ink">
            {formatIst(charge.enteredAt)}
            {charge.enteredByName ? ` by ${charge.enteredByName}` : ''} · revision {charge.revisionNo}
          </dd>
        </dl>
      ) : (
        <p className="m-0 text-quiet">No charges entered for this service yet.</p>
      )}
      {c.canEnter ? (
        <details className="rounded-control border border-line px-3.5 py-2.5" open={!charge}>
          <summary className={cn('cursor-pointer rounded-chip font-medium text-ink', focusRing)}>{charge ? 'Change charges' : 'Enter charges'}</summary>
          <div className="mt-3">
            {charge && c.status === 'sent_to_manager' ? <p className="m-0 mb-2 text-sm text-quiet">Changing a charge takes the case back from the Manager until you send it again.</p> : null}
            <CancellationChargeForm
              taskId={ws.task.taskId}
              expectedRevisionNo={charge?.revisionNo ?? 0}
              committedCostPaise={charge?.committedCostPaise ?? latestCostPaise}
              defaults={{ keepsPaise: charge?.supplierKeepsPaise ?? null, refundPaise: charge?.supplierRefundPaise ?? null, note: charge?.note ?? null }}
              action={actions.cancellationCharge}
              uploadAction={actions.uploadSupplierFile}
            />
          </div>
        </details>
      ) : null}
      {c.status === 'open' || c.status === 'charges_entered' ? (
        c.canSend ? (
          <OnePressForm fields={{ cancellationId: c.cancellationId, rowVersion: c.rowVersion, taskId: ws.task.taskId }} action={actions.sendCharges} label={T.sendChargesLabel} pendingLabel="Sending…" variant="primary" formLabel={T.sendChargesLabel} />
        ) : ws.canWork || c.canEnter ? (
          <UnavailableAction
            label={T.sendChargesLabel}
            reason={c.chargesMissing > 0 ? `${c.chargesMissing} ${c.chargesMissing === 1 ? 'service of this Deal still needs' : 'services of this Deal still need'} charges first.` : 'Enter this service’s charges first.'}
          />
        ) : null
      ) : null}
    </WorkCard>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function PurchaseWorkTab({
  ws,
  payments,
  actions,
  senderName,
  confirmState,
}: {
  ws: PurchaseWorkspaceView;
  /** B's purchase_payment_context; null when the read failed or is not installed (the card says so). */
  payments: PaymentContextView | null | 'error';
  actions: PurchaseWorkActions;
  /** The viewer's name, used to sign e-mail drafts. */
  senderName: string;
  confirmState?: ProcUiResult | null;
}) {
  const t = ws.task;
  const confirmed = t.status === 'supplier_confirmed';
  const latestNo = latestCostVersionNo(ws);
  const latest = ws.costVersions.find((c) => c.versionNo === latestNo) ?? null;
  const taskId = t.taskId;
  return (
    <section className="flex flex-col gap-5" aria-label="Purchase work">
      <WorkFlashProvider>
      {ws.gateIssue ? <Notice tone="warning">{PROCUREMENT_ISSUE_TEXT[ws.gateIssue]}</Notice> : null}
      {!ws.canWork && !ws.canApproveOverBudget && !confirmed ? (
        <Notice tone="locked" role="status">
          <p>{t.status === 'not_started' ? 'Take this task first. Only the person who takes it can add rates and send e-mails.' : `${t.assigneeName ?? 'A colleague'} is working on this. You can read it.`}</p>
        </Notice>
      ) : null}
      <Card>
        <section aria-labelledby="work-summary">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle id="work-summary">{t.serviceType === 'hotel' ? `${t.hotelName ?? t.itemTitle}${t.city ? ` · ${t.city}` : ''}` : t.itemTitle}</CardTitle>
              <CardDescription>Exactly what Sales entered in Book now for {t.dealReference}.</CardDescription>
            </div>
            {confirmed ? (
              <StatusBadge tone="success" icon={CircleCheck} wrap>
                <span className="sr-only">Booking: </span>Confirmed · reference {ws.supplierReference}
              </StatusBadge>
            ) : (
              <StatusBadge tone="info" icon={PlayCircle} wrap>
                <span className="sr-only">Booking: </span>Not booked yet
              </StatusBadge>
            )}
          </CardHeader>
          <CardBody>
            <BookedFacts task={t} idPrefix="work-booked" />
          </CardBody>
        </section>
      </Card>

      {ws.cancellation ? <CancellationCard ws={ws} latestCostPaise={latest?.amountPaise ?? null} actions={actions} /> : null}

      <RateNegotiationCard ws={ws} actions={actions} senderName={senderName} confirmState={confirmState} />

      {confirmed ? (
        <WorkCard id="work-confirmation" title="Supplier confirmation">
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(9rem,13rem)_1fr]">
            <dt className="text-sm font-medium text-quiet">Reference</dt>
            <dd className="m-0 text-ink wrap-anywhere">{ws.supplierReference}</dd>
            <dt className="text-sm font-medium text-quiet">Recorded</dt>
            <dd className="m-0 text-ink">
              {t.supplierConfirmedAt ? formatIst(t.supplierConfirmedAt) : 'Recorded'}
              {ws.supplierConfirmedByName ? ` by ${ws.supplierConfirmedByName}` : ''}
            </dd>
          </dl>
          <p className={metaClass}>The confirmation locked the final rate. Changes after confirmation aren’t supported yet.</p>
        </WorkCard>
      ) : null}

      {payments === 'error' ? (
        <WorkCard id="work-payments" title="Supplier payments">
          <Notice tone="warning" role="status">
            <p>Supplier payments could not be loaded just now. Reload the page to try again.</p>
          </Notice>
        </WorkCard>
      ) : payments ? (
        <SupplierPaymentsCard ctx={payments} actions={actions} />
      ) : null}

      <WorkCard id="work-files" title="Purchase files" description="Supplier quotes and confirmations. Only the Purchase team sees them.">
        {ws.evidence.length === 0 ? (
          <p className="m-0 text-quiet">No files yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Purchase files">
            {ws.evidence.map((f) => {
              const problem = f.status !== 'stored';
              return (
                <li key={f.id} className={cn('m-0 flex flex-wrap items-start gap-3 rounded-control border px-3.5 py-2.5', problem ? 'border-status-warning-line bg-status-warning-tint' : 'border-line bg-canvas')}>
                  {problem ? <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" /> : <FileCheck2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />}
                  <div className="min-w-40 flex-1">
                    <p className="m-0 font-medium wrap-anywhere text-ink">
                      {f.status === 'stored' ? (
                        <a href={`/app/purchase/files/${f.id}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                          {f.fileName}
                        </a>
                      ) : (
                        f.fileName
                      )}
                    </p>
                    <p className={metaClass}>
                      {PURCHASE_EVIDENCE_KIND_LABEL[f.kind]} · {sizeLabel(f.sizeBytes)} ·{' '}
                      {f.status === 'stored' ? 'Stored' : f.status === 'failed' ? 'Upload failed — does not count. Remove it and upload again.' : 'Upload not finished — does not count yet.'}
                    </p>
                  </div>
                  {ws.canWork && !confirmed ? (
                    <div className="shrink-0">
                      <RemovePurchaseFileForm taskId={taskId} evidenceId={f.id} fileName={f.fileName} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {ws.canWork && !confirmed ? <UploadPurchaseFileForm taskId={taskId} fileCount={ws.evidence.length} /> : null}
      </WorkCard>

      {ws.canRelease ? (
        <WorkCard id="work-release" title={A1_TEXT.releaseLabel}>
          <ReleaseTaskForm taskId={taskId} />
        </WorkCard>
      ) : null}

      {ws.canReassign && ws.assigneeUserId ? (
        <WorkCard id="work-reassign" title={A1_TEXT.reassignLabel} description={`Currently with ${t.assigneeName ?? 'a Purchase colleague'}.`}>
          <ReassignTaskForm taskId={taskId} expectedAssigneeId={ws.assigneeUserId} candidates={ws.reassignCandidates} />
        </WorkCard>
      ) : null}
      </WorkFlashProvider>
    </section>
  );
}

/** Spacing between the Work tab and the shared cost block below it. */
export function WorkStack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}
