import type { ReactNode } from 'react';
import { StatusPill, type StatusTone } from '@/components/StatusPill';
import { PageHeader } from '@/components/ui/page-header';
import {
  ACTION_BLOCK_TEXT,
  type ActionBlock,
  type BillingStatus,
  type DestinationKind,
  FINANCE_DISCLAIMER,
  FINANCE_ERROR_TEXT,
  type FinanceEvidenceKind,
  type MoneySummary,
  type Paise,
  RECEIPT_STATUS_LABEL,
  type ReceiptStatus,
  type ReceiptEvidenceView,
  type RejectionKind,
  type ReversalKind,
  type ReviewStatus,
} from '@/modules/finance/contracts';

/*
 * Phase 5A Accounts: shared pieces used by server views and client forms.
 * No server-only imports here, so client components can use it too.
 * Money arrives as whole-paise digit strings and is formatted with BigInt
 * only (never a JS number), using Indian digit grouping.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** "₹12,34,567.89" from paise digits. Invalid input shows as "—" rather than a wrong number. */
export function formatInr(paise: Paise | null | undefined): string {
  if (paise === null || paise === undefined || !/^-?\d+$/.test(paise)) return '—';
  const value = BigInt(paise);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const hundred = BigInt(100);
  const rupees = groupIndian((abs / hundred).toString());
  const rem = (abs % hundred).toString().padStart(2, '0');
  return `${negative ? '−' : ''}₹${rupees}.${rem}`;
}

/** Paise digits as a rupee input value ("125000.50"), for prefilled forms. */
export function paiseToRupeesField(paise: Paise | null | undefined): string {
  if (!paise || !/^\d+$/.test(paise)) return '';
  const value = BigInt(paise);
  const hundred = BigInt(100);
  const rem = value % hundred;
  return rem === BigInt(0) ? (value / hundred).toString() : `${value / hundred}.${rem.toString().padStart(2, '0')}`;
}

export function isZero(paise: Paise | null | undefined): boolean {
  return !paise || /^0+$/.test(paise);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_ONLY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** "14 Nov 2026" from "2026-11-14" (a calendar date, no time zone shift). */
export function finDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? iso : DATE_ONLY.format(t);
}

/** "6 Oct 2026, 10:15 am IST" from an ISO timestamp. */
export function finDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${DATE_TIME.format(t)} IST`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const REJECTION_KIND_LABEL: Record<RejectionKind, string> = {
  not_received: 'money not received',
  data_error: 'details entered wrongly',
};

export const REVERSAL_KIND_LABEL: Record<ReversalKind, string> = {
  bank_return: 'returned by the bank',
  not_received: 'money not received',
  data_error: 'details entered wrongly',
};

export const BILLING_STATUS_LABEL: Record<BillingStatus, string> = {
  draft: 'Saved, not verified',
  verified: 'Verified',
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: 'Waiting for Accounts review',
  returned: 'Returned to Sales',
  approved: 'Approved by Accounts',
};

/** Reason text for a blocked action. `billing_not_verified` comes from the review approval block. */
export function blockText(block: Exclude<ActionBlock, null> | 'billing_not_verified'): string {
  return block === 'billing_not_verified' ? FINANCE_ERROR_TEXT.billing_not_verified : ACTION_BLOCK_TEXT[block];
}

// ---------------------------------------------------------------------------
// Company accounts (Stage 2)
// ---------------------------------------------------------------------------

/** "Bank name XXXX6789" or "Payee s***@handle": the masked form used in lists and selectors. */
export function maskedDestination(d: { kind: DestinationKind; bankName: string | null; accountMasked: string | null; payeeName?: string | null; upiMasked: string | null }): string {
  if (d.kind === 'bank') return [d.bankName, d.accountMasked].filter(Boolean).join(' ') || 'Bank account';
  return [d.payeeName, d.upiMasked].filter(Boolean).join(' ') || 'UPI ID';
}

// ---------------------------------------------------------------------------
// Small display components
// ---------------------------------------------------------------------------

/** The disclaimer every finance screen carries (contract §15). */
export function FinanceDisclaimer() {
  return (
    <p className="fin-disclaimer" role="note">
      <span aria-hidden="true">ⓘ </span>
      {FINANCE_DISCLAIMER}
    </p>
  );
}

const RECEIPT_TONE: Record<ReceiptStatus, { tone: StatusTone; glyph: string }> = {
  recorded: { tone: 'info', glyph: '◐' },
  verified: { tone: 'ok', glyph: '●' },
  pending_clearance: { tone: 'info', glyph: '◔' },
  cleared: { tone: 'ok', glyph: '●' },
  bounced: { tone: 'danger', glyph: '✕' },
  stopped: { tone: 'danger', glyph: '✕' },
  cancelled: { tone: 'neutral', glyph: '–' },
  rejected: { tone: 'danger', glyph: '✕' },
  reversed: { tone: 'warn', glyph: '↺' },
};

export function receiptStatusText(status: ReceiptStatus, isCheque: boolean, rejection: RejectionKind | null, reversal: ReversalKind | null): string {
  if (status === 'recorded' && isCheque) return 'Cheque recorded, awaiting verification';
  if (status === 'rejected' && rejection) return `${RECEIPT_STATUS_LABEL.rejected} (${REJECTION_KIND_LABEL[rejection]})`;
  if (status === 'reversed' && reversal) return `${RECEIPT_STATUS_LABEL.reversed} (${REVERSAL_KIND_LABEL[reversal]})`;
  return RECEIPT_STATUS_LABEL[status];
}

export function ReceiptStatusPill({
  status,
  isCheque,
  rejection = null,
  reversal = null,
}: {
  status: ReceiptStatus;
  isCheque: boolean;
  rejection?: RejectionKind | null;
  reversal?: ReversalKind | null;
}) {
  const t = RECEIPT_TONE[status];
  return (
    <StatusPill tone={t.tone} glyph={t.glyph} label="Receipt status:">
      {receiptStatusText(status, isCheque, rejection, reversal)}
    </StatusPill>
  );
}

export function BillingPill({ status }: { status: BillingStatus | null }) {
  if (!status) {
    return (
      <StatusPill tone="warn" glyph="○" label="Billing details:">
        Not entered yet
      </StatusPill>
    );
  }
  return (
    <StatusPill tone={status === 'verified' ? 'ok' : 'info'} glyph={status === 'verified' ? '●' : '◐'} label="Billing details:">
      {BILLING_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export function ReviewPill({ status }: { status: ReviewStatus | null }) {
  if (!status) {
    return (
      <StatusPill tone="neutral" glyph="–" label="Review:">
        No confirmed booking to review
      </StatusPill>
    );
  }
  const tone: StatusTone = status === 'approved' ? 'ok' : status === 'returned' ? 'warn' : 'info';
  const glyph = status === 'approved' ? '●' : status === 'returned' ? '↩' : '◐';
  return (
    <StatusPill tone={tone} glyph={glyph} label="Review:">
      {REVIEW_STATUS_LABEL[status]}
    </StatusPill>
  );
}

/**
 * The three money figures, side by side and never added together
 * (contract §9.5). Each one says what it is and what it is not.
 */
export function MoneyFigures({ money, compact = false, headingId }: { money: MoneySummary; compact?: boolean; headingId?: string }) {
  return (
    <dl className={`fin-money${compact ? ' is-compact' : ''}`} aria-labelledby={headingId}>
      <div className="fin-money-item is-available">
        <dt>Available customer funds</dt>
        <dd>{formatInr(money.availablePaise)}</dd>
        {compact ? null : <dd className="fin-money-hint">Verified receipts and cleared cheques.</dd>}
      </div>
      <div className="fin-money-item is-waiting">
        <dt>Awaiting verification</dt>
        <dd>{formatInr(money.awaitingVerificationPaise)}</dd>
        {compact ? null : <dd className="fin-money-hint">Recorded, not checked yet. Not available.</dd>}
      </div>
      <div className="fin-money-item is-cheque">
        <dt>Cheques awaiting clearance</dt>
        <dd>{formatInr(money.chequesAwaitingClearancePaise)}</dd>
        {compact ? null : <dd className="fin-money-hint">Not available until the bank clears them.</dd>}
      </div>
    </dl>
  );
}

/** One line saying why an action is not available to this viewer. Text carries the meaning. */
export function BlockedReason({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="fin-blocked">
      <span aria-hidden="true">⊘ </span>
      {children}
    </p>
  );
}

/**
 * Finance-page header (Direction A P-HEADER): eyebrow, the one h1, status
 * near the top, at most one primary action, then the page's own lines and
 * the disclaimer. Built on the design-system PageHeader.
 */
export function FinanceHeader({
  eyebrow,
  title,
  children,
  status,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  /** Status pills and owner, shown under the title. */
  status?: ReactNode;
  /** The page's ONE primary action. */
  actions?: ReactNode;
}) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} status={status} actions={actions} className="mb-3" />
      <div className="mb-5 flex flex-col gap-2 font-sans text-base text-copy [&_p]:m-0" data-slot="finance-header-lines">
        {children}
        <FinanceDisclaimer />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Private proof files (receipts and bank deposits)
// ---------------------------------------------------------------------------

export const EVIDENCE_KIND_LABEL: Record<FinanceEvidenceKind, string> = {
  bank_proof: 'Bank proof (statement line or credit advice)',
  cheque_image: 'Cheque image',
  deposit_slip: 'Bank deposit slip',
};

/**
 * Stored files link to /app/accounts/files/[id], which authorizes the viewer
 * again (Accounts in the file's entity, audited) and then redirects to a
 * 60-second signed Storage URL. A refusal is a plain 404 and a Storage
 * problem a 503; the page never holds a Storage URL itself, so an expired
 * link is fixed by opening the file again from here.
 */
export function EvidenceList({
  evidence,
  label = 'Proof files',
  emptyText = 'No proof uploaded.',
  describedBy,
}: {
  evidence: ReceiptEvidenceView[];
  label?: string;
  emptyText?: string;
  /** Id of a hint that applies to every stored file link. */
  describedBy?: string;
}) {
  const visible = evidence.filter((e) => e.status !== 'removed');
  if (visible.length === 0) return <p className="offer-meta">{emptyText}</p>;
  return (
    <ul className="file-list fin-files" aria-label={label}>
      {visible.map((e) => (
        <li key={e.id} className={`file-row ${e.status === 'stored' ? 'is-stored' : 'is-problem'}`}>
          <span className="file-glyph" aria-hidden="true">
            {e.status === 'stored' ? '✓' : '!'}
          </span>
          <span>
            {e.status === 'stored' ? (
              <a className="file-name" href={`/app/accounts/files/${e.id}`} aria-describedby={describedBy}>
                {e.fileName}
              </a>
            ) : (
              <span className="file-name">{e.fileName}</span>
            )}
            <span className="file-meta">
              {' '}
              · {EVIDENCE_KIND_LABEL[e.kind]} ·{' '}
              {e.status === 'stored' ? 'Stored' : e.status === 'pending_upload' ? 'Upload not finished — does not count' : 'Upload failed — does not count'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
