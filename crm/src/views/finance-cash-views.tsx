import { Banknote } from 'lucide-react';
import { StatusPill } from '@/components/StatusPill';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import {
  type CashBranchView,
  type CashOverview,
  type FinancePolicyPage,
  type FinancePolicyView,
  UNRESOLVED_CASH_KINDS,
  type UnresolvedCashItem,
  type UnresolvedCashKind,
} from '@/modules/finance/contracts';
import { EvidenceList, FinanceDisclaimer, FinanceHeader, finDate, finDateTime, formatInr, isZero } from './finance-common';
import Link from 'next/link';
import type { MoneyRulesModel } from '@/modules/settings/server/queries';
import { READ_ONLY_WORDS } from '@/modules/settings/text';
import { SettingsSectionHeading } from './settings/settings-frame';
import { SettingsSectionView } from './settings/setting-rows';
import {
  DepositDecisionForms,
  type FinanceActions,
  type FinanceActionState,
  PolicyEditForm,
  RecordDepositForm,
  RecordReconciliationForm,
  VerifyReconciliationForm,
} from './finance-forms';

/*
 * Phase 5A cash custody and finance policy screens (contract §6, §12).
 * Cash per branch: verified cash not yet deposited, unresolved work,
 * deposits and daily counts. Phase 5B Milestone A §2: unresolved work is
 * grouped by kind with complete totals and the oldest date; a daily count is
 * missing, awaiting verification, out of date or verified, never ambiguous. Policy: current, scheduled and past versions as
 * a timeline (adapted from 21st.dev "Changelog Timeline" 28356, reusing the
 * Phase 4 cost-timeline styles), legal ceilings read-only.
 */

const UNRESOLVED_TEXT: Record<UnresolvedCashKind, { title: string; next: string; unit: [string, string]; tone: 'warn' | 'danger'; glyph: string }> = {
  deposit_overdue: {
    title: 'Verified cash not deposited in time',
    next: 'Deposit it at the bank and record the deposit with the slip.',
    unit: ['receipt', 'receipts'],
    tone: 'danger',
    glyph: '!',
  },
  verification_overdue: {
    title: 'Cash recorded but not verified in time',
    next: 'Another Accounts person must verify or reject the receipt.',
    unit: ['receipt', 'receipts'],
    tone: 'danger',
    glyph: '!',
  },
  reversed_undeposited: {
    title: 'Reversed cash still at the branch',
    next: 'Cash for a reversed receipt is still at the branch. Settle it with the branch and the owner; it stays listed here.',
    unit: ['receipt', 'receipts'],
    tone: 'danger',
    glyph: '!',
  },
  reconciliation_missing: {
    title: 'Daily cash count missing',
    next: 'Record the cash count for this business date. A missing count stays listed until a count is recorded and verified, however old it is.',
    unit: ['date', 'dates'],
    tone: 'warn',
    glyph: '!',
  },
  reconciliation_awaiting_verification: {
    title: 'Daily cash count awaiting verification',
    next: 'A count is recorded but not verified, so the date is not cleared yet. Another Accounts person must verify it.',
    unit: ['date', 'dates'],
    tone: 'warn',
    glyph: '◐',
  },
  reconciliation_stale: {
    title: 'Verified cash count is out of date',
    next: 'An entry was posted on or before this date after the count was verified. Count again and record a new count.',
    unit: ['date', 'dates'],
    tone: 'danger',
    glyph: '!',
  },
};

/** Every unresolved item across kinds, from the complete per-kind totals (never from the listed items alone). */
export function unresolvedTotal(b: Pick<CashBranchView, 'unresolvedTotals'>): number {
  return UNRESOLVED_CASH_KINDS.reduce((sum, kind) => sum + (b.unresolvedTotals[kind] ?? 0), 0);
}

function itemLine(u: UnresolvedCashItem): string {
  return [u.receiptNo, u.businessDate ? finDate(u.businessDate) : null, u.amountPaise ? formatInr(u.amountPaise) : null].filter(Boolean).join(' · ');
}

/**
 * Unresolved cash work grouped by kind. Counts and the oldest date come from
 * the complete totals, so a list bounded to the oldest items never hides how
 * much work exists. "Nothing unresolved" appears only when every total is zero.
 */
function UnresolvedList({ b }: { b: CashBranchView }) {
  const total = unresolvedTotal(b);
  const kinds = UNRESOLVED_CASH_KINDS.filter((kind) => (b.unresolvedTotals[kind] ?? 0) > 0 || b.unresolved.some((u) => u.kind === kind));
  if (total === 0 && kinds.length === 0) {
    return (
      <p className="fin-all-clear">
        <span aria-hidden="true">✓ </span>Nothing unresolved at this branch.
      </p>
    );
  }
  return (
    <>
      {b.unresolvedTruncated ? (
        <Notice tone="warning" className="mb-3">
          <p>Long lists show only their oldest items. The counts below include every unresolved item at this branch.</p>
        </Notice>
      ) : null}
      <ul className="problem-list" aria-label={`Unresolved cash work at ${b.branchName}`}>
        {kinds.map((kind) => {
          const t = UNRESOLVED_TEXT[kind];
          const items = b.unresolved.filter((u) => u.kind === kind);
          const count = Math.max(b.unresolvedTotals[kind] ?? 0, items.length);
          const oldest = b.oldestUnresolvedDate[kind];
          return (
            <li key={kind} className={`problem problem-${t.tone}`}>
              <span className="problem-glyph" aria-hidden="true">
                {t.glyph}
              </span>
              <div className="problem-body">
                <p className="problem-title m-0">{t.title}</p>
                <p className="problem-sentence m-0">
                  {count} {count === 1 ? t.unit[0] : t.unit[1]}
                  {oldest ? ` · oldest ${finDate(oldest)}` : ''}
                </p>
                <p className="m-0">{t.next}</p>
                {items.length < count ? (
                  <p className="hint m-0">
                    Showing the {items.length} oldest of {count}.
                  </p>
                ) : null}
                {items.length > 0 ? (
                  <ul className="mt-4 m-0" aria-label={`${t.title}: listed items`}>
                    {items.map((u, i) => (
                      <li key={`${u.receiptId ?? u.businessDate ?? 'item'}-${i}`}>{itemLine(u)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function BranchCash({ entityId, b, actions }: { entityId: string; b: CashBranchView; actions: FinanceActions }) {
  const h = `cash-${b.branchId}`;
  // Defensive: listed items always count, even if a total were to arrive lower.
  const total = Math.max(unresolvedTotal(b), b.unresolved.length);
  return (
    <section className="fin-card" aria-labelledby={h}>
      <div className="panel-header m-0">
        <h2 id={h} className="m-0">
          {b.branchName}
        </h2>
        {total > 0 ? (
          <StatusPill tone="danger" glyph="!" label="Branch cash:">
            {total} unresolved
          </StatusPill>
        ) : (
          <StatusPill tone="ok" glyph="●" label="Branch cash:">
            Up to date
          </StatusPill>
        )}
      </div>
      <dl className="fin-money is-two">
        <div className="fin-money-item is-available">
          <dt>Verified cash in hand</dt>
          <dd>{formatInr(b.cashInHandPaise)}</dd>
          <dd className="fin-money-hint">Verified cash receipts not yet in a verified bank deposit. Physical cash held for reversed receipts is not included; it is listed as a custody item under Unresolved.</dd>
        </div>
        <div className="fin-money-item is-waiting">
          <dt>Cash recorded, not verified</dt>
          <dd>{formatInr(b.recordedUnverifiedCashPaise)}</dd>
          <dd className="fin-money-hint">Shown separately; not part of cash in hand.</dd>
        </div>
      </dl>

      <h3>Unresolved</h3>
      <UnresolvedList b={b} />

      <h3>Verified cash waiting for deposit</h3>
      {b.undepositedVerified.length === 0 ? null : (
        <div className="table-scroll">
          <table className="stack-table">
            <caption className="visually-hidden">Verified cash waiting for deposit at {b.branchName}</caption>
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Deal</th>
                <th scope="col">Received</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {b.undepositedVerified.map((r) => (
                <tr key={r.receiptId}>
                  <td data-label="Receipt">{r.receiptNo}</td>
                  <td data-label="Deal">{r.dealReference}</td>
                  <td data-label="Received">{finDate(r.receivedOn)}</td>
                  <td data-label="Amount" className="fin-num">
                    {formatInr(r.amountPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RecordDepositForm entityId={entityId} branch={b} action={actions.recordDepositAction} />

      <h3>Bank deposits</h3>
      {b.deposits.length === 0 ? (
        <p className="hint">No deposits recorded.</p>
      ) : (
        <ul className="fin-plain-list" aria-label={`Bank deposits at ${b.branchName}`}>
          {b.deposits.map((dep) => (
            <li key={dep.depositId} className="fin-row-card">
              <div className="panel-header m-0">
                <p className="m-0">
                  <strong>{formatInr(dep.totalPaise)}</strong> on {finDate(dep.depositedOn)} · ref <span className="fin-mono">{dep.bankReference}</span>
                </p>
                <StatusPill tone={dep.status === 'verified' ? 'ok' : dep.status === 'rejected' ? 'danger' : 'info'} glyph={dep.status === 'verified' ? '●' : dep.status === 'rejected' ? '✕' : '◐'} label="Deposit:">
                  {dep.status === 'verified' ? 'Verified' : dep.status === 'rejected' ? 'Rejected' : 'Awaiting verification'}
                </StatusPill>
              </div>
              <p className="offer-meta">
                Receipts {dep.receiptNos.join(', ')}
                {dep.recordedByName ? ` · recorded by ${dep.recordedByName}` : ''}
                {dep.verifiedByName ? ` · verified by ${dep.verifiedByName}` : ''}
              </p>
              <EvidenceList
                evidence={dep.evidence}
                label={`Deposit slip for ${dep.bankReference}`}
                emptyText="No stored deposit slip for this deposit."
                describedBy={`slip-hint-${dep.depositId}`}
              />
              {dep.evidence.some((e) => e.status === 'stored') ? (
                <p className="hint" id={`slip-hint-${dep.depositId}`}>
                  The slip opens through a private link that works for 60 seconds. If it has expired, open it again from here.
                </p>
              ) : null}
              {dep.rejectReason ? <p className="offer-meta prewrap">Rejected: {dep.rejectReason}</p> : null}
              <DepositDecisionForms entityId={entityId} deposit={dep} actions={actions} />
            </li>
          ))}
        </ul>
      )}

      <h3>Daily cash counts</h3>
      {b.reconciliations.length === 0 ? (
        <p className="hint">No cash counts recorded.</p>
      ) : (
        <ul className="fin-plain-list" aria-label={`Daily cash counts at ${b.branchName}`}>
          {b.reconciliations.map((rec) => (
            <li key={rec.reconciliationId} className={`fin-row-card${rec.stale ? ' is-stale' : ''}`}>
              <div className="panel-header m-0">
                <p className="m-0">
                  <strong>{finDate(rec.businessDate)}</strong>
                </p>
                {rec.stale ? (
                  <StatusPill tone="danger" glyph="!" label="Cash count:">
                    Out of date: count again
                  </StatusPill>
                ) : (
                  <StatusPill tone={rec.status === 'verified' ? 'ok' : 'info'} glyph={rec.status === 'verified' ? '●' : '◐'} label="Cash count:">
                    {rec.status === 'verified' ? 'Verified' : 'Awaiting verification'}
                  </StatusPill>
                )}
              </div>
              <dl className="facts fin-rec-facts">
                <dt>Counted</dt>
                <dd>{formatInr(rec.countedPaise)}</dd>
                <dt>Expected (verified cash in hand)</dt>
                <dd>{formatInr(rec.expectedPaise)}</dd>
                <dt>Difference</dt>
                <dd>
                  <strong>{isZero(rec.differencePaise) ? 'None' : formatInr(rec.differencePaise)}</strong>
                </dd>
                <dt>Recorded, unverified cash up to that date</dt>
                <dd>{formatInr(rec.unverifiedCashPaise)} (shown so a difference can be explained)</dd>
                {rec.note ? (
                  <>
                    <dt>Note</dt>
                    <dd className="prewrap">{rec.note}</dd>
                  </>
                ) : null}
              </dl>
              <p className="offer-meta">
                {rec.recordedByName ? `Recorded by ${rec.recordedByName}` : ''}
                {rec.verifiedByName ? ` · verified by ${rec.verifiedByName}` : ''}
              </p>
              <VerifyReconciliationForm entityId={entityId} rec={rec} action={actions.verifyReconciliationAction} />
            </li>
          ))}
        </ul>
      )}
      <RecordReconciliationForm entityId={entityId} branch={b} action={actions.recordReconciliationAction} />
    </section>
  );
}

export function CashOverviewView({ overview, actions }: { overview: CashOverview; actions: FinanceActions }) {
  const p = overview.policy;
  return (
    <>
      <FinanceHeader eyebrow="Accounts" title="Branch cash">
        <p>
          Cash must be deposited within {p.cashDepositDays} working {p.cashDepositDays === 1 ? 'day' : 'days'} (Monday to Saturday).{' '}
          {p.reconciliationRequired ? 'A daily cash count is required for each business date with cash activity.' : 'A daily cash count is not required by the current policy.'}
        </p>
      </FinanceHeader>
      {overview.branches.length === 0 ? (
        <Card>
          <EmptyState icon={Banknote} headingLevel={2} title="No branch cash yet" description="Branches appear here once a cash receipt is recorded." />
        </Card>
      ) : (
        overview.branches.map((b) => <BranchCash key={b.branchId} entityId={overview.legalEntityId} b={b} actions={actions} />)
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Finance policy
// ---------------------------------------------------------------------------

function PolicyFacts({ v }: { v: FinancePolicyView }) {
  return (
    <dl className="facts">
      <dt>Largest single receipt</dt>
      <dd>{formatInr(v.receiptMaxPaise)}</dd>
      <dt>Cash per payer per day</dt>
      <dd>{isZero(v.cashPayerDayCapPaise) ? 'Cash off (₹0.00)' : formatInr(v.cashPayerDayCapPaise)}</dd>
      <dt>Cash per trip</dt>
      <dd>{isZero(v.cashTripCapPaise) ? 'Cash off (₹0.00)' : formatInr(v.cashTripCapPaise)}</dd>
      <dt>Days to deposit cash</dt>
      <dd>
        {v.cashDepositDays} working {v.cashDepositDays === 1 ? 'day' : 'days'}
      </dd>
      <dt>Daily cash count</dt>
      <dd>{v.reconciliationRequired ? 'Required' : 'Not required'}</dd>
    </dl>
  );
}

function VersionStep({ v, tag }: { v: FinancePolicyView; tag: 'current' | 'scheduled' | 'past' }) {
  return (
    <li className={`cost-step${tag === 'current' ? ' is-committed' : tag === 'scheduled' ? ' is-latest' : ''}`}>
      <span className="cost-dot" aria-hidden="true">
        {v.versionNo}
      </span>
      <div>
        <p className="m-0">
          <strong>
            Version {v.versionNo} · {tag === 'current' ? 'in force' : tag === 'scheduled' ? 'scheduled' : 'replaced'}
          </strong>
        </p>
        <p className="offer-meta">
          {tag === 'scheduled' ? 'Takes effect' : 'Effective'} {finDateTime(v.effectiveAt)} · saved {finDateTime(v.createdAt)}
          {v.createdByName ? ` by ${v.createdByName}` : ''}
        </p>
        <p className="offer-meta">
          Receipt max {formatInr(v.receiptMaxPaise)} · cash per payer per day {formatInr(v.cashPayerDayCapPaise)} · cash per trip {formatInr(v.cashTripCapPaise)} · deposit within {v.cashDepositDays}{' '}
          {v.cashDepositDays === 1 ? 'day' : 'days'} · daily count {v.reconciliationRequired ? 'required' : 'not required'}
        </p>
        <p className="offer-meta prewrap">Reason: {v.reason}</p>
      </div>
    </li>
  );
}

/**
 * Settings · Money rules (DA-264): the finance policy (A-26 line; history and
 * change form as before, keyed per reply) and, read only, which payment modes
 * are available per company with their last change (DA-253: changed by the
 * CRM team with the owner's approval, not here). Inside the Settings frame,
 * so the page heading is a section heading.
 */
export function FinancePolicyPageView({
  page,
  actions,
  editInitialState = null,
  paymentModes,
  companyAccountsHref = null,
}: {
  page: FinancePolicyPage;
  actions: Pick<FinanceActions, 'updatePolicyAction'>;
  editInitialState?: FinanceActionState | null;
  /** Read-only payment modes per company (Terra moneyRulesModel). Absent: no section. */
  paymentModes?: MoneyRulesModel;
  /** Accounts → Company accounts, for a Super Admin who can open it. */
  companyAccountsHref?: string | null;
}) {
  const history = page.history.filter((h) => h.versionNo !== page.current.versionNo);
  return (
    <>
      <SettingsSectionHeading description={`Limits for receipts and cash at ${page.legalEntityName}. Each change is a new version with a reason.`}>Finance policy</SettingsSectionHeading>
      <FinanceDisclaimer />

      <div className="fin-grid">
        <section className="fin-card" aria-labelledby="pol-current">
          <div className="panel-header m-0">
            <h3 id="pol-current" className="m-0">
              Current policy
            </h3>
            <StatusPill tone="ok" glyph="●" label="Policy:">
              Version {page.current.versionNo} in force
            </StatusPill>
          </div>
          <p className="hint">Since {finDateTime(page.current.effectiveAt)}.</p>
          <PolicyFacts v={page.current} />
        </section>
        <section className="fin-card" aria-labelledby="pol-ceilings">
          <h3 id="pol-ceilings">Legal ceilings</h3>
          <p className="hint">Set by the owner after the CA confirms the law. Read-only here; policy values must stay within them.</p>
          <dl className="facts">
            <dt>Cash limit ceiling</dt>
            <dd>{formatInr(page.ceilings.cashCapCeilingPaise)}</dd>
            <dt>Receipt maximum ceiling</dt>
            <dd>{formatInr(page.ceilings.receiptMaxCeilingPaise)}</dd>
          </dl>
        </section>
      </div>

      {page.scheduled.length > 0 ? (
        <section className="fin-card" aria-labelledby="pol-scheduled">
          <h3 id="pol-scheduled">Scheduled changes</h3>
          <ol className="cost-timeline" aria-label="Scheduled policy versions">
            {page.scheduled.map((v) => (
              <VersionStep key={v.versionNo} v={v} tag="scheduled" />
            ))}
          </ol>
        </section>
      ) : null}

      <section className="fin-card" aria-labelledby="pol-edit">
        <h3 id="pol-edit">Change the policy</h3>
        {page.canEdit ? (
          <PolicyEditForm page={page} action={actions.updatePolicyAction} initialState={editInitialState} />
        ) : (
          <p className="m-0">You can read this policy but not change it. Only a Super Admin who does not also hold the Accounts role can change it.</p>
        )}
      </section>

      {paymentModes ? (
        <section className="flex flex-col gap-3" aria-labelledby="pay-modes-heading">
          <h3 id="pay-modes-heading" className="m-0 text-lg font-semibold text-ink">
            Payment modes
          </h3>
          {paymentModes.sectionText ? (
            <Notice tone="warning" role="status">
              <p>{paymentModes.sectionText}</p>
            </Notice>
          ) : null}
          {paymentModes.companies.map((c) => (
            <SettingsSectionView key={c.legalEntityId} id={`pay-modes-${c.legalEntityId}`} title={c.legalName} section={{ rows: c.rows, sectionText: null, canSwitch: false }} />
          ))}
          {companyAccountsHref ? (
            <p className="m-0 text-sm text-copy">
              {READ_ONLY_WORDS.finance_mode.companyAccounts.replace(' Accounts → Company accounts.', ' ')}
              <Link href={companyAccountsHref} className="font-semibold text-brand-strong underline underline-offset-4">
                Accounts → Company accounts
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="fin-card" aria-labelledby="pol-history">
        <h3 id="pol-history">History</h3>
        <ol className="cost-timeline" aria-label="Policy versions, newest first">
          <VersionStep v={page.current} tag="current" />
          {history.map((v) => (
            <VersionStep key={v.versionNo} v={v} tag="past" />
          ))}
        </ol>
      </section>
    </>
  );
}
