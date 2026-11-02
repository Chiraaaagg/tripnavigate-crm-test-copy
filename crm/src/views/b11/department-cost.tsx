'use client';

import { Inbox, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { HandForm, useSavedKey } from '@/components/hand-form';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Fieldset } from '@/components/ui/fieldset';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Tabs } from '@/components/ui/tabs';
import {
  EXPENSE_ACTION_BLOCK_TEXT,
  EXPENSE_RECORD_STATUS_LABEL,
  EXPENSE_TEXT,
  type AccountsExpenseFilter,
  type AccountsExpenseRecordItem,
  type AccountsExpenseRecordsPage,
} from '@/modules/finance/contracts';
import {
  COST_KIND_LABEL,
  COST_KINDS,
  COST_PAID_BY,
  COST_PAID_BY_LABEL,
  COST_PAYMENT_MODE_LABEL,
  COST_PAYMENT_MODES,
  DEPARTMENT_COST_TEXT,
  EXPENSE_STATUS_LABEL,
  FLIGHT_DIRECT_PAYMENT_LIMIT_PAISE,
  type CostKind,
  type CostPaidBy,
  type DepartmentCostView,
  type DepartmentEvidenceView,
  type ExpenseStatus,
  type WorkFormDepartment,
} from '@/modules/fulfilment/contracts';
import { dateText, inr, paiseToRupeesText, rupeesTextToPaise } from './book-fields';
import { AreaField, MoneyField, SelectField, TextField, problemFor } from './controls';
import { newRequestId, PendingButton, refusedFields, ResultBox, useB11Action, type UiResult } from './form-kit';
import type { B11Action } from './shapes';

/*
 * Department work form, cost block (B1.1c, DEC-28): one shape for Flight, the
 * Visa & Passport desk and (read-only for now) Purchase. A company-paid cost
 * becomes an expense record for Accounts review — never an approval or a
 * payment. Plus the Accounts list of expense records (/app/accounts/expenses).
 */

const EXPENSE_TONE: Record<ExpenseStatus, StatusTone> = { draft: 'neutral', submitted: 'info', accepted: 'success', returned: 'danger' };

export function ExpenseStatusPill({ status, accounts = false }: { status: ExpenseStatus; accounts?: boolean }) {
  return (
    <StatusBadge tone={EXPENSE_TONE[status]} wrap>
      <span className="sr-only">Expense record: </span>
      {accounts ? EXPENSE_RECORD_STATUS_LABEL[status] : EXPENSE_STATUS_LABEL[status]}
    </StatusBadge>
  );
}

export interface CostActions {
  save: B11Action;
  submit: B11Action;
  upload: B11Action;
}

export function DepartmentCostCard({
  taskId,
  department,
  costs,
  evidence = [],
  canRecord,
  readOnlyReason,
  actions,
  initialState,
  startOpen = false,
}: {
  taskId: string;
  department: WorkFormDepartment;
  costs: DepartmentCostView[];
  evidence?: DepartmentEvidenceView[];
  canRecord: boolean;
  readOnlyReason: string | null;
  actions?: CostActions;
  /** Preview gallery: first answer of the new-cost form. */
  initialState?: UiResult | null;
  startOpen?: boolean;
}) {
  const [adding, setAdding] = useState(startOpen);
  const receipts = evidence.filter((e) => e.kind === 'fee_receipt' || e.kind === 'direct_payment_proof');
  return (
    <Card>
      <section aria-labelledby={`cost-${taskId}-heading`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`cost-${taskId}-heading`}>{department === 'visa' ? 'Fees and costs' : 'Cost'}</CardTitle>
            <CardDescription>What the department paid, by whom and how.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {readOnlyReason || department === 'purchase' ? (
            <Notice tone="locked">{readOnlyReason ?? DEPARTMENT_COST_TEXT.purchasePlaceholder}</Notice>
          ) : (
            <>
              {department === 'flight' ? <Notice tone="info">{DEPARTMENT_COST_TEXT.flightOverLimit}</Notice> : null}
              {department === 'visa' ? <Notice tone="info">{DEPARTMENT_COST_TEXT.companyFeeNote}</Notice> : null}
            </>
          )}
          {costs.length === 0 ? (
            <p className="m-0 text-quiet">No cost recorded yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Costs recorded">
              {costs.map((c) => (
                <li key={c.entryId} className="m-0">
                  <CostRow cost={c} department={department} actions={actions} receipts={receipts} />
                </li>
              ))}
            </ol>
          )}
          {receipts.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm" aria-label="Company payment proofs stored">
              {receipts.map((e) => (
                <li key={e.id}>
                  <a href={`/app/department/evidence/${e.id}`} rel="noopener" className="rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4">
                    {e.fileName}
                  </a>{' '}
                  <span className="text-quiet">· {e.kind === 'fee_receipt' ? 'fee receipt' : 'direct-payment proof'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {canRecord && actions && department === 'flight' ? (
            <details className="rounded-control border border-line bg-canvas">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium text-brand-strong">Upload the direct-payment proof</summary>
              <div className="border-t border-line bg-card px-3 py-3">
                <DepartmentUploadForm taskId={taskId} kinds={[{ value: 'direct_payment_proof', label: 'Direct payment proof' }]} action={actions.upload} label="Upload the direct-payment proof" />
              </div>
            </details>
          ) : null}
          {canRecord && actions && department !== 'purchase' ? (
            adding ? (
              <CostForm taskId={taskId} department={department} receipts={receipts} action={actions.save} initialState={initialState} onDone={() => setAdding(false)} />
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  <Plus aria-hidden="true" /> Record a cost
                </Button>
              </div>
            )
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function CostRow({ cost, department, actions, receipts }: { cost: DepartmentCostView; department: WorkFormDepartment; actions?: CostActions; receipts: DepartmentEvidenceView[] }) {
  const hasReceipt = Boolean(cost.receiptEvidenceId);
  const [editing, setEditing] = useState(false);
  const [submitState, submitAction] = useB11Action(actions?.submit ?? (async () => ({ ok: false as const, code: 'not_authorized' as const, message: '' })));
  return (
    <article className="flex flex-col gap-2 rounded-control border border-line bg-canvas px-3.5 py-3" aria-label={`${COST_KIND_LABEL[cost.costKind]} ${inr(cost.amountPaise)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-semibold text-ink tabular-nums">
          {COST_KIND_LABEL[cost.costKind]} · {inr(cost.amountPaise)}
        </p>
        {cost.expenseStatus ? <ExpenseStatusPill status={cost.expenseStatus} /> : <StatusBadge tone="neutral">Paid by {COST_PAID_BY_LABEL[cost.paidBy].toLowerCase()} · no expense record</StatusBadge>}
      </div>
      <p className="m-0 text-sm text-copy">
        Paid by: {COST_PAID_BY_LABEL[cost.paidBy]}
        {cost.paymentMode ? ` · ${COST_PAYMENT_MODE_LABEL[cost.paymentMode]}` : ''}
        {cost.paidOn ? ` · ${dateText(cost.paidOn)}` : ''}
        {cost.reference ? ` · reference ${cost.reference}` : ''}
      </p>
      {cost.returnReason ? <Notice tone="danger">Accounts returned it: {cost.returnReason}</Notice> : null}
      {cost.receiptEvidenceId ? (
        <p className="m-0 text-sm text-quiet">Receipt: {receipts.find((r) => r.id === cost.receiptEvidenceId)?.fileName ?? 'stored'}</p>
      ) : null}
      {cost.expenseStatus === 'submitted' ? <p className="m-0 text-sm text-quiet">{DEPARTMENT_COST_TEXT.sentToAccounts}</p> : null}
      <div className="flex flex-wrap gap-2">
        {cost.canEdit && actions ? (
          <Button variant="ghost" size="sm" aria-expanded={editing} onClick={() => setEditing((x) => !x)}>
            {editing ? 'Close' : 'Change this cost'}
          </Button>
        ) : null}
        {cost.canSubmit && actions ? (
          <form action={submitAction} noValidate className="flex flex-col gap-2">
            <input type="hidden" name="taskId" value={cost.taskId} />
            <input type="hidden" name="entryId" value={cost.entryId} />
            <input type="hidden" name="rowVersion" value={cost.rowVersion} />
            <PendingButton pendingLabel="Sending…" variant="secondary" describedBy={hasReceipt ? undefined : `cost-${cost.entryId}-receipt-note`}>
              Send to Accounts
            </PendingButton>
            {!hasReceipt ? (
              <p id={`cost-${cost.entryId}-receipt-note`} className="m-0 text-sm text-quiet">
                {department === 'flight' ? 'Upload the direct-payment proof, then choose it under “Change this cost”.' : 'Upload the fee receipt, then choose it under “Change this cost”.'}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
      <ResultBox result={submitState} successText={DEPARTMENT_COST_TEXT.sentToAccounts} />
      {editing && actions ? <CostForm taskId={cost.taskId} department={department} cost={cost} receipts={receipts} action={actions.save} onDone={() => setEditing(false)} /> : null}
    </article>
  );
}

function CostForm({
  taskId,
  department,
  cost,
  receipts,
  action,
  initialState,
  onDone,
}: {
  taskId: string;
  department: WorkFormDepartment;
  cost?: DepartmentCostView;
  receipts: DepartmentEvidenceView[];
  action: B11Action;
  initialState?: UiResult | null;
  onDone: () => void;
}) {
  const kinds: CostKind[] = department === 'flight' ? ['fare', 'other'] : ['government_fee', 'service_fee', 'other'];
  const [v, setV] = useState({
    costKind: cost?.costKind ?? kinds[0]!,
    amount: paiseToRupeesText(cost?.amountPaise),
    paidBy: cost?.paidBy ?? ('not_yet' as CostPaidBy),
    paymentMode: cost?.paymentMode ?? '',
    paidOn: cost?.paidOn ?? '',
    reference: cost?.reference ?? '',
    receiptEvidenceId: cost?.receiptEvidenceId ?? receipts[0]?.id ?? '',
  });
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action, {
    initialState,
    onSuccess: () => {
      setRequestId(newRequestId());
      onDone();
    },
  });
  const fields = refusedFields(state);
  const prefix = cost ? `cost-${cost.entryId}` : `cost-${taskId}-new`;
  const amountPaise = rupeesTextToPaise(v.amount) ?? 0;
  const overLimit = department === 'flight' && v.paidBy === 'company' && amountPaise > Number(FLIGHT_DIRECT_PAYMENT_LIMIT_PAISE);
  const paid = v.paidBy !== 'not_yet';
  return (
    <HandForm action={formAction} noValidate aria-label={cost ? 'Change this cost' : 'Record a cost'} className="flex flex-col gap-3">
      <ResultBox result={state} successText="Cost saved." />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="entryId" value={cost?.entryId ?? ''} />
      <input type="hidden" name="rowVersion" value={cost?.rowVersion ?? 0} />
      <input type="hidden" name="requestId" value={requestId} />
      <Fieldset legend={cost ? 'Change the cost' : 'New cost'} columns={2}>
        <SelectField id={`${prefix}-kind`} name="costKind" label="What was it for" value={v.costKind} onChange={(x) => setV({ ...v, costKind: x as CostKind })} options={COST_KINDS.filter((k) => kinds.includes(k)).map((k) => ({ value: k, label: COST_KIND_LABEL[k] }))} />
        <MoneyField
          id={`${prefix}-amount`}
          name="amountRupees"
          label="Amount ₹"
          value={v.amount}
          onChange={(x) => setV({ ...v, amount: x })}
          error={problemFor(fields, 'amountRupees', overLimit ? DEPARTMENT_COST_TEXT.flightOverLimit : 'Enter the amount in rupees, more than ₹0.') ?? (overLimit ? DEPARTMENT_COST_TEXT.flightOverLimit : null)}
        />
        <SelectField id={`${prefix}-paid-by`} name="paidBy" label="Paid by" value={v.paidBy} onChange={(x) => setV({ ...v, paidBy: x as CostPaidBy })} options={COST_PAID_BY.map((p) => ({ value: p, label: COST_PAID_BY_LABEL[p] }))} />
        {paid ? (
          <>
            <SelectField
              id={`${prefix}-mode`}
              name="paymentMode"
              label="How it was paid"
              value={v.paymentMode}
              onChange={(x) => setV({ ...v, paymentMode: x as typeof v.paymentMode })}
              options={[{ value: '', label: 'Choose' }, ...COST_PAYMENT_MODES.map((m) => ({ value: m, label: COST_PAYMENT_MODE_LABEL[m] }))]}
              error={problemFor(fields, 'paymentMode', 'Choose how it was paid.')}
            />
            <TextField id={`${prefix}-paid-on`} name="paidOn" label="Paid on" type="date" value={v.paidOn} onChange={(x) => setV({ ...v, paidOn: x })} error={problemFor(fields, 'paidOn', 'Enter the payment date (today or earlier).')} />
            <TextField id={`${prefix}-reference`} name="reference" label="Reference" optional value={v.reference} onChange={(x) => setV({ ...v, reference: x })} maxLength={120} />
            <SelectField
              id={`${prefix}-receipt`}
              name="receiptEvidenceId"
              label={department === 'flight' ? 'Direct-payment proof' : 'Payment receipt'}
              optional={v.paidBy !== 'company'}
              hint={receipts.length === 0 ? 'Upload it first; a company-paid cost needs it before it goes to Accounts.' : undefined}
              value={v.receiptEvidenceId}
              onChange={(x) => setV({ ...v, receiptEvidenceId: x })}
              options={[{ value: '', label: receipts.length === 0 ? 'None uploaded yet' : 'Not chosen' }, ...receipts.map((r) => ({ value: r.id, label: r.fileName }))]}
              error={problemFor(fields, 'receiptEvidenceId', 'Choose the stored receipt.')}
            />
          </>
        ) : (
          <p className="m-0 self-end text-sm text-quiet">Not paid yet: it will go through a supplier payment request.</p>
        )}
      </Fieldset>
      {v.paidBy === 'company' ? <Notice tone="info">{DEPARTMENT_COST_TEXT.companyFeeNote}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <PendingButton pendingLabel="Saving…" variant="primary" disabled={overLimit}>
          Save cost
        </PendingButton>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </HandForm>
  );
}

/** File upload for department evidence (fee receipt, direct-payment proof, applicant document, authority outcome). */
export function DepartmentUploadForm({
  taskId,
  applicationId = null,
  kinds,
  action,
  label,
  initialState,
}: {
  taskId: string;
  applicationId?: string | null;
  kinds: Array<{ value: string; label: string }>;
  action: B11Action;
  label: string;
  initialState?: UiResult | null;
}) {
  const [kind, setKind] = useState(kinds[0]?.value ?? 'other');
  const [state, formAction] = useB11Action(action, { initialState });
  // Submitted by hand (no React reset, so the kind stays as chosen); the file input empties after a save.
  const savedKey = useSavedKey(state);
  const id = `up-${taskId}-${applicationId ?? 'task'}`;
  return (
    <HandForm action={formAction} noValidate aria-label={label} className="flex flex-col gap-3">
      <ResultBox result={state} successText="File stored." />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="applicationId" value={applicationId ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        {kinds.length > 1 ? <SelectField id={`${id}-kind`} name="kind" label="What is this file?" value={kind} onChange={setKind} options={kinds} /> : <input type="hidden" name="kind" value={kind} />}
        <Field htmlFor={`${id}-file`} label="File" hint="PDF, JPG, PNG or WebP, up to 4 MB. Stored privately.">
          <input
            key={savedKey}
            id={`${id}-file`}
            name="file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            aria-describedby={fieldDescribedBy(`${id}-file`, { hint: true })}
            className="block w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
          />
        </Field>
      </div>
      <div>
        <PendingButton pendingLabel="Uploading…">Upload file</PendingButton>
      </div>
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Accounts: expense records
// ---------------------------------------------------------------------------

const EXPENSE_FILTER_LABEL: Record<AccountsExpenseFilter, string> = {
  submitted: 'To review',
  returned: 'Returned',
  accepted: 'Accepted',
  all: 'All',
};

export function AccountsExpensesView({
  page,
  filter,
  hrefs,
  moreHref,
  acceptAction,
  returnAction,
}: {
  page: AccountsExpenseRecordsPage;
  filter: AccountsExpenseFilter;
  hrefs: Record<AccountsExpenseFilter, string>;
  moreHref: string | null;
  acceptAction: B11Action;
  returnAction: B11Action;
}) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Accounts" title="Department costs" description={EXPENSE_TEXT.callout} />
      <Tabs label="Department cost filters" items={(Object.keys(EXPENSE_FILTER_LABEL) as AccountsExpenseFilter[]).map((f) => ({ href: hrefs[f], label: EXPENSE_FILTER_LABEL[f], current: f === filter, count: f === filter ? page.totalCount : undefined }))} className="mb-4" />
      {page.items.length === 0 ? (
        <div className="rounded-card border border-line bg-card shadow-card">
          <EmptyState icon={Inbox} title={filter === 'submitted' ? 'No department costs to review' : 'Nothing here'} description={filter === 'submitted' ? 'When a department sends a company-paid cost, it appears here.' : 'Nothing matches this filter.'} headingLevel={2} />
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={EXPENSE_FILTER_LABEL[filter]}>
          {page.items.map((r) => (
            <li key={r.entryId} className="m-0">
              <ExpenseCard record={r} acceptAction={acceptAction} returnAction={returnAction} />
            </li>
          ))}
        </ol>
      )}
      {page.hasMore && moreHref ? (
        <p className="m-0 mt-4">
          <Link href={moreHref} className={buttonVariants({ variant: 'secondary' })}>
            Show more
          </Link>
        </p>
      ) : null}
    </div>
  );
}

const DEPARTMENT_NAME: Record<AccountsExpenseRecordItem['department'], string> = { purchase: 'Purchase', flight: 'Flight team', visa: 'Visa & Passport desk' };

function ExpenseCard({ record, acceptAction, returnAction }: { record: AccountsExpenseRecordItem; acceptAction: B11Action; returnAction: B11Action }) {
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [acceptRequest] = useState(() => newRequestId());
  const [returnRequest] = useState(() => newRequestId());
  const [acceptState, accept] = useB11Action(acceptAction);
  const [returnState, doReturn] = useB11Action(returnAction);
  const blocks = [...new Set([record.actions.accept, record.actions.return].filter((b): b is NonNullable<typeof b> => Boolean(b)))];
  return (
    <article className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-3.5 shadow-card" aria-label={`Expense ${record.dealReference} ${inr(record.amountPaise)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-semibold text-ink">
          {record.dealId ? (
            <Link href={`/app/accounts/deals/${record.dealId}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4', focusRing)}>
              {record.dealReference}
            </Link>
          ) : (
            record.dealReference
          )}{' '}
          <span className="font-normal text-copy">
            · {DEPARTMENT_NAME[record.department]} · {COST_KIND_LABEL[record.kind]}
          </span>
        </p>
        <ExpenseStatusPill status={record.status} accounts />
      </div>
      <SummaryList>
        <SummaryRow label="Amount" numeric>
          {inr(record.amountPaise)}
        </SummaryRow>
        <SummaryRow label="Paid by, how, when">
          {COST_PAID_BY_LABEL[record.paidBy]}
          {record.paymentMode ? ` · ${COST_PAYMENT_MODE_LABEL[record.paymentMode as keyof typeof COST_PAYMENT_MODE_LABEL] ?? record.paymentMode}` : ''}
          {record.paidOn ? ` · ${dateText(record.paidOn)}` : ''}
          {record.reference ? ` · reference ${record.reference}` : ''}
        </SummaryRow>
        <SummaryRow label="Sent">
          {record.submittedByName ?? 'Department'}
          {record.submittedAt ? ` · ${dateText(record.submittedAt)}` : ''}
        </SummaryRow>
        <SummaryRow label="Receipt">
          {record.evidence.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {record.evidence.map((e) => (
                <li key={e.id}>
                  <a href={`/app/department/evidence/${e.id}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4', focusRing)} rel="noopener">
                    {e.fileName}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            'Not stored'
          )}
        </SummaryRow>
        {record.returnReason ? <SummaryRow label="Returned because">{record.returnReason}</SummaryRow> : null}
      </SummaryList>
      {blocks.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-quiet">
          {blocks.map((b) => (
            <li key={b}>{EXPENSE_ACTION_BLOCK_TEXT[b]}</li>
          ))}
        </ul>
      ) : null}
      {record.status === 'submitted' && (!record.actions.accept || !record.actions.return) ? (
        <div className="flex flex-col gap-3">
          <ResultBox result={acceptState} successText="Accepted. Recorded for Accounts only: no payment was approved or made." />
          <div className="flex flex-wrap gap-2">
            {!record.actions.accept ? (
              <form action={accept} noValidate>
                <input type="hidden" name="entryId" value={record.entryId} />
                <input type="hidden" name="rowVersion" value={record.rowVersion} />
                <input type="hidden" name="requestId" value={acceptRequest} />
                <PendingButton pendingLabel="Accepting…" variant="primary">
                  {EXPENSE_TEXT.acceptLabel}
                </PendingButton>
              </form>
            ) : null}
            {!record.actions.return ? (
              <Button variant="secondary" size="lg" className="min-h-11" aria-expanded={returning} onClick={() => setReturning((x) => !x)}>
                {EXPENSE_TEXT.returnLabel}
              </Button>
            ) : null}
          </div>
          {returning ? (
            <form action={doReturn} noValidate aria-label="Return the expense record" className="flex flex-col gap-3">
              <ResultBox result={returnState} successText="Returned to the department with your reason." />
              <input type="hidden" name="entryId" value={record.entryId} />
              <input type="hidden" name="rowVersion" value={record.rowVersion} />
              <input type="hidden" name="requestId" value={returnRequest} />
              <AreaField id={`exp-${record.entryId}-reason`} name="reason" label="Why are you returning it?" hint="10 to 500 characters. The department reads it." value={reason} onChange={setReason} rows={2} maxLength={500} error={problemFor(refusedFields(returnState), 'reason', 'Write 10 to 500 characters.')} />
              <div>
                <PendingButton pendingLabel="Returning…" variant="danger">
                  Return with this reason
                </PendingButton>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
