import { Landmark } from 'lucide-react';
import { StatusPill, type StatusTone } from '@/components/StatusPill';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import {
  type CompanyDestinationsPage,
  type CompanyDestinationView,
  DESTINATION_KIND_LABEL,
  DESTINATION_STATE_LABEL,
  DESTINATION_VERSION_STATUS_LABEL,
  type DestinationState,
  type DestinationVersionStatus,
  type DestinationVersionView,
} from '@/modules/finance/contracts';
import { BlockedReason, FinanceHeader, finDateTime, maskedDestination } from './finance-common';
import {
  DestinationDecisionForms,
  DestinationForm,
  type FinanceActions,
  type FinanceActionState,
  RetireDestinationForm,
  ShowDestinationDetailForm,
} from './finance-forms';

/*
 * Stage 2: Accounts › Company accounts (bank accounts and UPI IDs customers
 * pay into). Masked values only; full values come from the audited
 * "Show full details" POST and live only in that form's state.
 *
 * Design (see docs/implementation/next/phase-5a-design.md, Stage 2 entry):
 * each account is a card reusing the receipt card layout; the decision area
 * follows the approve/return pair idea of 21st.dev "Permissions Button"
 * (26522) rebuilt on the existing inline forms; version history reuses the
 * cost timeline already adapted from "Changelog Timeline" (28356); fields
 * keep the existing Field wrapper (label, hint, error), which matches
 * "Field" (11458).
 */

export type DestinationActions = Pick<
  FinanceActions,
  'submitDestinationAction' | 'approveDestinationAction' | 'returnDestinationAction' | 'retireDestinationAction' | 'showDestinationDetailAction'
>;

const STATE_TONE: Record<DestinationState, { tone: StatusTone; glyph: string }> = {
  submitted: { tone: 'info', glyph: '◐' },
  returned: { tone: 'warn', glyph: '↩' },
  approved: { tone: 'ok', glyph: '●' },
  retired: { tone: 'neutral', glyph: '–' },
};

const VERSION_TONE: Record<DestinationVersionStatus, { tone: StatusTone; glyph: string }> = {
  submitted: { tone: 'info', glyph: '◐' },
  returned: { tone: 'warn', glyph: '↩' },
  approved: { tone: 'ok', glyph: '●' },
  superseded: { tone: 'neutral', glyph: '–' },
};

function byWhom(name: string | null, at: string | null): string {
  return `${at ? finDateTime(at) : ''}${name ? ` by ${name}` : ''}`.trim();
}

/** "Synthetic Bank XXXX6789 · IFSC SYNB0001234 · holder …" or "Payee s***@handle". */
function versionLine(kind: CompanyDestinationView['kind'], v: DestinationVersionView): string {
  const masked = maskedDestination({ kind, bankName: v.bankName, accountMasked: v.accountMasked, payeeName: v.payeeName, upiMasked: v.upiMasked });
  if (kind === 'bank') return [masked, v.ifsc ? `IFSC ${v.ifsc}` : null, v.holderName ? `holder ${v.holderName}` : null].filter(Boolean).join(' · ');
  return masked;
}

function returnedVersion(d: CompanyDestinationView): DestinationVersionView | null {
  return d.versions.find((v) => v.versionNo === d.latestVersionNo && v.status === 'returned') ?? null;
}

function submitBlockText(d: CompanyDestinationView): string {
  if (d.state === 'retired') return 'Retired accounts cannot be changed. Add a new company account instead.';
  if (d.pending) return `Version ${d.pending.versionNo} is waiting for approval. New details can be submitted after it is approved or returned.`;
  return 'New details cannot be submitted for this account right now. Reload the page to see the latest state.';
}

function VersionHistory({ d, actions }: { d: CompanyDestinationView; actions: DestinationActions }) {
  const versions = [...d.versions].sort((a, b) => b.versionNo - a.versionNo);
  return (
    <details className="form-section work-form">
      <summary>
        <span className="form-section-title">
          Version history ({versions.length})<span className="visually-hidden"> for {d.label}</span>
        </span>
      </summary>
      <div>
        <p className="hint">Versions are never changed after they are submitted. Receipts keep the version they were recorded against.</p>
        <ol className="cost-timeline" aria-label={`Versions of ${d.label}, newest first`}>
          {versions.map((v) => {
            const t = VERSION_TONE[v.status];
            const isCurrent = d.current?.versionId === v.versionId;
            return (
              <li key={v.versionId} className={`cost-step${isCurrent ? ' is-committed' : v.status === 'submitted' ? ' is-latest' : ''}`}>
                <span className="cost-dot" aria-hidden="true">
                  {v.versionNo}
                </span>
                <div>
                  <p className="m-0">
                    <strong>Version {v.versionNo}</strong>{' '}
                    <StatusPill tone={t.tone} glyph={t.glyph} label="Version status:">
                      {v.status === 'approved' && d.state === 'retired' ? 'Approved (account retired)' : DESTINATION_VERSION_STATUS_LABEL[v.status]}
                    </StatusPill>
                  </p>
                  <p className="offer-meta">{versionLine(d.kind, v)}</p>
                  <p className="offer-meta">
                    Submitted {byWhom(v.makerName, v.createdAt)}
                    {v.predecessorVersionNo !== null ? ` · follows version ${v.predecessorVersionNo}` : ''}
                    {v.decidedAt ? ` · ${v.status === 'returned' ? 'returned' : 'approved'} ${byWhom(v.decidedByName, v.decidedAt)}` : ''}
                  </p>
                  {v.decisionReason ? <p className="offer-meta prewrap">Reason: {v.decisionReason}</p> : null}
                  <ShowDestinationDetailForm kind={d.kind} version={v} destinationLabel={d.label} action={actions.showDestinationDetailAction} />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}

function DestinationCard({ d, entityId, actions }: { d: CompanyDestinationView; entityId: string; actions: DestinationActions }) {
  const headingId = `dest-${d.destinationId}`;
  const retired = d.state === 'retired';
  const returned = returnedVersion(d);
  const tone = STATE_TONE[d.state];
  return (
    <li className={`fin-receipt${retired ? ' is-cancelled' : ''}`} aria-labelledby={headingId}>
      <div className="fin-receipt-head">
        <div>
          <h3 id={headingId} className="m-0">
            {d.label}
          </h3>
          <p className="offer-meta">
            {DESTINATION_KIND_LABEL[d.kind]} · added {byWhom(d.createdByName, d.createdAt)}
          </p>
        </div>
      </div>
      <p className="m-0 button-row">
        <StatusPill tone={tone.tone} glyph={tone.glyph} label="Account status:">
          {DESTINATION_STATE_LABEL[d.state]}
        </StatusPill>
        {retired && d.pending ? (
          <StatusPill tone="info" glyph="◐" label="Open version:">
            Version {d.pending.versionNo} submitted after retirement
          </StatusPill>
        ) : null}
      </p>
      <dl className="facts fin-receipt-facts">
        <dt>Used by new receipts</dt>
        <dd>
          {retired ? (
            'No. This account is retired.'
          ) : d.current ? (
            <>
              Version {d.current.versionNo} · {versionLine(d.kind, d.current)}
              <span className="fin-sub">Approved {byWhom(d.current.decidedByName, d.current.decidedAt)}</span>
            </>
          ) : (
            'Not yet. No version has been approved.'
          )}
        </dd>
        {d.pending ? (
          <>
            <dt>Waiting for approval</dt>
            <dd>
              Version {d.pending.versionNo} · {versionLine(d.kind, d.pending)}
              <span className="fin-sub">Submitted {byWhom(d.pending.makerName, d.pending.createdAt)}</span>
            </dd>
          </>
        ) : null}
        {returned ? (
          <>
            <dt>Returned</dt>
            <dd>
              Version {returned.versionNo}, returned {byWhom(returned.decidedByName, returned.decidedAt)}
              {returned.decisionReason ? <span className="fin-sub prewrap">Reason: {returned.decisionReason}</span> : null}
            </dd>
          </>
        ) : null}
        {retired ? (
          <>
            <dt>Retired</dt>
            <dd>
              {byWhom(d.retiredByName, d.retiredAt) || 'Yes'}
              {d.retireReason ? <span className="fin-sub prewrap">Reason: {d.retireReason}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>

      {d.pending ? (
        <>
          {retired ? (
            <div className="note info" role="note">
              <p className="m-0">This version was waiting when the account was retired. It cannot be approved; another Accounts person can return it.</p>
            </div>
          ) : null}
          <ShowDestinationDetailForm kind={d.kind} version={d.pending} destinationLabel={d.label} action={actions.showDestinationDetailAction} />
          <DestinationDecisionForms destination={d} version={d.pending} actions={actions} />
        </>
      ) : null}

      <div className="fin-actions" role="group" aria-label={`Changes to ${d.label}`}>
        {d.actions.submit === null ? (
          <details className="form-section work-form fin-action-form">
            <summary>
              <span className="form-section-title">
                {returned ? 'Submit a corrected version' : d.current ? 'Replace with new details' : 'Submit new details'}
                <span className="visually-hidden"> for {d.label}</span>
              </span>
            </summary>
            <DestinationForm entityId={entityId} destination={d} action={actions.submitDestinationAction} />
          </details>
        ) : (
          <BlockedReason>{submitBlockText(d)}</BlockedReason>
        )}
        {retired ? null : d.actions.retire === null ? (
          <RetireDestinationForm destination={d} action={actions.retireDestinationAction} />
        ) : (
          <BlockedReason>This account cannot be retired in its current state. Reload the page to see the latest state.</BlockedReason>
        )}
      </div>

      <VersionHistory d={d} actions={actions} />
    </li>
  );
}

export function CompanyDestinationsView({
  page,
  actions,
  addInitialState = null,
}: {
  page: CompanyDestinationsPage;
  actions: DestinationActions;
  /** Design previews only: open the add form with a refusal already shown. */
  addInitialState?: FinanceActionState | null;
}) {
  const list = page.destinations;
  const inUse = list.filter((d) => d.state !== 'retired' && d.current).length;
  const waiting = list.filter((d) => d.pending).length;
  return (
    <>
      <FinanceHeader eyebrow="Accounts" title="Company accounts">
        <p>Company bank accounts and UPI IDs customers pay into. A second Accounts person approves each one.</p>
      </FinanceHeader>

      <Notice tone="restricted" className="mb-4">
        <p>
          Account numbers and UPI IDs are masked on this page. “Show full details” opens one version; each opening is recorded with your name and the time.
        </p>
        <p>Approval confirms the company details as entered. It does not check that the bank account belongs to the company, and it is not a payment.</p>
      </Notice>

      <section className="fin-card mt-6" aria-labelledby="dest-list-heading">
        <h2 id="dest-list-heading">Accounts</h2>
        {list.length === 0 ? (
          <EmptyState
            icon={Landmark}
            headingLevel={3}
            title="No company accounts yet"
            description="Add the first bank account or UPI ID below. Receipts can select it once a different Accounts person approves it."
          />
        ) : (
          <>
            <p className="hint">
              {list.length} {list.length === 1 ? 'account' : 'accounts'} · {inUse} in use by new receipts · {waiting} waiting for approval
            </p>
            <ol className="fin-receipt-list" aria-label="Company accounts">
              {list.map((d) => (
                <DestinationCard key={d.destinationId} d={d} entityId={page.entityId} actions={actions} />
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="fin-card" aria-labelledby="dest-add-heading">
        <h2 id="dest-add-heading">Add a company account</h2>
        <details className="form-section work-form" open={list.length === 0 || addInitialState !== null || undefined}>
          <summary>
            <span className="form-section-title">Add a bank account or UPI ID</span>
          </summary>
          <DestinationForm entityId={page.entityId} action={actions.submitDestinationAction} initialState={addInitialState} />
        </details>
      </section>
    </>
  );
}
