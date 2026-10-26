'use client';

import { CalendarDays, ChevronRight, CircleAlert, FileText, Info, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { SaveStatus } from '@/components/ui/save-status';
import { EVIDENCE_MIME_TYPES } from '@/modules/fulfilment/contracts';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import { formatInr, isIsoDate, paiseToRupeesText, rupeesToPaise } from '@/modules/fulfilment/booking-form-model';
import { guard } from '../booking-forms';
import { dateText } from '../b11/book-fields';
import { SalesClaimsPanel } from '../b11/book-claims';
import { ChangeClassForm, DiscardRevisionForm, SubmitBookingForm } from '../b11/book-review';
import { QuotationSourceNote } from '../b11/quotation-source';
import { useSectionForm } from '../b11/draft-sync';
import { newRequestId, normaliseResult, type UiResult } from '../b11/form-kit';
import type { BookNowView } from '../b11/shapes';
import { refusalReason, useAutosave, useSaveQueue } from './autosave-queue';
import { HiddenDraftInputs, editableOf } from './form-helpers';
import { useFormToast } from './form-toast';
import { SectionBody, SectionCard } from './parts';
import { SERVICE_CHIPS } from './service-labels';
import { useFormStep } from './step-context';
import type { BookingFormActions } from './types';

/*
 * Step 3 cards after Bill To (Book now v2, change 9): Payment plan (its own
 * card, saves itself), Customer's written OK (its own card), "Payment already
 * received? (optional)" and "Review trip and services" (both collapsed), and
 * the submit card. The shared Book now parts (payment reports, submit with
 * its confirmation, the revision forms) are wrapped, not changed.
 */

export const SUBMIT_TRIGGER_ID = 'bf-submit-trigger';

export function submitBlockedReason(view: BookNowView): string | null {
  const blocking = view.checklist.filter((i) => i.blocking);
  const stageWaiting = blocking.some((i) => i.code === 'stage_not_confirmed');
  if (!view.version) return 'Start the booking draft first.';
  if (view.dealNotActive) return 'This deal is lost or rejected in Bitrix, so the booking cannot change.';
  if (stageWaiting && blocking.length === 1) return 'Waiting for Won - Payment Received in Bitrix. You can keep preparing.';
  if (!view.canSubmit) return view.submitBlockedReason ?? 'Only the deal owner or the branch Manager can submit this booking.';
  return null;
}

interface PlanRow {
  label: string;
  amount: string;
  due: string;
}

/** Plan checks before it saves (the server's rules, said per instalment). */
export function planIssues(rows: readonly PlanRow[]): string[] {
  const out: string[] = [];
  rows.forEach((r, i) => {
    if (!r.label.trim() && !r.amount.trim() && !r.due) return;
    if (!r.label.trim() || r.label.trim().length > 60) out.push(`Instalment ${i + 1}: label (up to 60 characters).`);
    const p = rupeesToPaise(r.amount);
    if (!p || BigInt(p) <= 0n) out.push(`Instalment ${i + 1}: amount in rupees.`);
    if (!isIsoDate(r.due)) out.push(`Instalment ${i + 1}: due date.`);
  });
  return out;
}

export function PlanCard({ view, action, totalPaise }: { view: BookNowView; action: BookingFormActions['savePlan']; totalPaise: string | null }) {
  const editable = editableOf(view) && view.canEditCommercials;
  const loaded: PlanRow[] = (view.plan ?? []).map((p) => ({ label: p.label, amount: paiseToRupeesText(p.amountPaise), due: p.dueDate }));
  const f = useSectionForm({ id: 'plan', section: 'payment', label: 'Payment plan', order: 80, action, initial: { rows: loaded }, versionBound: true, rowVersion: view.version?.rowVersion ?? 0, saveable: false, tracksDirty: true });
  const rows = f.values.rows;
  const setRows = (fn: (x: PlanRow[]) => PlanRow[]) => f.setValues((s) => ({ rows: fn(s.rows) }));
  const formRef = useRef<HTMLFormElement | null>(null);
  const bindForm = f.bindForm;
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      bindForm(el);
    },
    [bindForm],
  );
  const save = useAutosave({
    key: 'plan',
    values: f.values,
    dirty: f.dirty,
    enabled: editable,
    hasStored: loaded.length > 0,
    check: () => planIssues(f.values.rows),
    send: () => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve({ ok: false, code: 'unexpected', message: '' } as UiResult)),
  });
  const sum = rows.reduce((s, r) => {
    const p = rupeesToPaise(r.amount);
    return s + (typeof p === 'string' ? BigInt(p) : 0n);
  }, 0n);
  const total = totalPaise ? BigInt(totalPaise) : null;
  const diff = total === null ? null : sum - total;
  const sumText = total === null ? 'of a total not worked out yet' : diff === 0n ? `of ${formatInr(String(total))} · matches the total` : `of ${formatInr(String(total))} · ${diff! > 0n ? 'more' : 'less'} than the total by ${formatInr(String(diff! < 0n ? -diff! : diff!))}`;
  return (
    <SectionCard id="plan" title="Payment plan" icon={CalendarDays} action={editable ? <SaveStatus id="pill-plan" state={save.state} reason={save.reason} label="Payment plan" /> : null}>
      {/* Old links to #payment and #bf-plan land here. */}
      <span id="payment" />
      <span id="bf-plan" />
      <form ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="plan-heading">
        <SectionBody>
          <HiddenDraftInputs view={view} base={f.base} result={f.state} />
          <p className="m-0 mb-3.5 text-sm text-quiet">When the customer will pay. Instalments must add up to the final total. No advance is required. A plan is not money received.</p>
          {!view.commercials ? <p className="m-0 mb-3.5 text-quiet">The payment plan is filled by Sales on this deal.</p> : null}
          <ol className="m-0 list-none p-0" aria-label="Instalments">
            {rows.map((r, i) => (
              <li key={i} className="mb-2.5 grid grid-cols-[1.2fr_1fr_1fr_2.25rem] items-end gap-2.5 max-sm:grid-cols-2">
                <Field htmlFor={`payment-${i + 1}-label`} label={`Instalment ${i + 1}`}>
                  <Input id={`payment-${i + 1}-label`} name="instalmentLabel" value={r.label} maxLength={60} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} disabled={!editable} />
                </Field>
                <Field htmlFor={`payment-${i + 1}-amount`} label="Amount ₹">
                  <MoneyInput id={`payment-${i + 1}-amount`} name="instalmentAmountRupees" value={r.amount} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} disabled={!editable} />
                </Field>
                <Field htmlFor={`payment-${i + 1}-due`} label="Due date">
                  <Input id={`payment-${i + 1}-due`} name="instalmentDueDate" type="date" value={r.due} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, due: e.target.value } : y)))} disabled={!editable} />
                </Field>
                {editable ? (
                  <Button variant="ghost" size="icon" className="size-9 max-sm:col-start-2 max-sm:justify-self-end" aria-label={`Remove instalment ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ol>
          {editable ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {rows.length < 12 ? (
                <Button size="sm" onClick={() => setRows((x) => [...x, { label: x.length ? 'Balance' : 'Advance', amount: '', due: '' }])}>
                  <Plus aria-hidden="true" />
                  Add instalment
                </Button>
              ) : null}
              {total !== null ? (
                <Button size="sm" onClick={() => setRows(() => [{ label: 'Full payment', amount: paiseToRupeesText(String(total)), due: '' }])}>
                  Use the full total as one instalment
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="m-0 flex justify-between gap-3 rounded-control bg-wash px-3 py-2.5 text-sm" aria-live="polite">
            <span>Plan total</span>
            <b className="text-right tabular-nums">
              {formatInr(String(sum), '₹0')} {sumText}
            </b>
          </p>
          {save.state === 'fix' && save.reason ? (
            <p id="why-plan" className="m-0 mt-3 flex items-start gap-1.5 text-sm font-medium text-status-danger">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{save.reason}</span>
            </p>
          ) : null}
        </SectionBody>
      </form>
    </SectionCard>
  );
}

async function run(action: unknown, fd: FormData): Promise<UiResult> {
  return normaliseResult(await guard(action as never)(null, fd)) as UiResult;
}

/** "Customer’s written OK for this version": its own card (change 9). Choosing a file uploads it. */
export function OkCard({ view, actions }: { view: BookNowView; actions: BookingFormActions }) {
  const router = useRouter();
  const queue = useSaveQueue();
  const toast = useFormToast();
  const editable = editableOf(view);
  const version = view.version;
  const evidence = view.evidence.filter((e) => e.status !== 'removed');
  const stored = evidence.filter((e) => e.status === 'stored');
  const stale = view.checklist.some((i) => i.code === 'quote_acceptance_stale');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const upload = async (file: File | undefined) => {
    if (!file || !version || busy) return;
    if (file.size > 4 * 1024 * 1024 || !(EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setProblem('Use a PDF, JPG, PNG or WebP file up to 4 MB. Nothing was uploaded.');
      return;
    }
    setBusy(true);
    setProblem(null);
    const fd = new FormData();
    fd.set('dealId', view.dealId);
    fd.set('versionId', version.versionId);
    fd.set('kind', 'acceptance_message');
    fd.set('file', file);
    const r = await queue.run(() => run(actions.uploadEvidence, fd));
    setBusy(false);
    setKey((k) => k + 1);
    if (r.ok) {
      router.refresh();
      toast('Acceptance proof stored for this version.');
    } else setProblem(r.code === 'upload_failed' ? 'The upload did not finish. The file is not stored. Try again.' : refusalReason(r));
  };
  const remove = async (id: string) => {
    const fd = new FormData();
    fd.set('dealId', view.dealId);
    fd.set('evidenceId', id);
    const r = await queue.run(() => run(actions.removeEvidence, fd));
    if (r.ok) router.refresh();
    else setProblem(refusalReason(r));
  };
  return (
    <SectionCard id="ok" title="Customer’s written OK for this version" icon={FileText} action={stored.length > 0 ? <SaveStatus state="saved" text="Stored" label="Customer’s written OK" /> : null}>
      <span id="bf-acceptance" />
      <SectionBody className="flex flex-col gap-3">
        <p className="m-0 text-sm text-quiet">A Bitrix stage is not proof. If you change anything after uploading, upload a new OK.</p>
        <QuotationSourceNote source={view.quotationSource} stale={stale} />
        {!view.evidenceVisible ? (
          <Notice tone="locked">Only Sales on this deal and the branch Manager can open proof files.</Notice>
        ) : (
          <>
            {evidence.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2.5 rounded-chip border border-line bg-card px-2.5 py-2 text-sm">
                <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  {e.status === 'stored' ? (
                    <a href={`/app/bookings/evidence/${e.id}`} rel="noopener" className={cn('text-copy underline-offset-4 hover:underline', focusRing)}>
                      {e.fileName}
                    </a>
                  ) : (
                    e.fileName
                  )}
                  {' · '}
                  {e.status === 'stored' ? 'Stored' : 'Upload did not finish: not stored'}
                </span>
                {editable ? (
                  <Button variant="link" size="sm" onClick={() => void remove(e.id)}>
                    Remove<span className="sr-only"> {e.fileName}</span>
                  </Button>
                ) : null}
              </div>
            ))}
            {editable && version && evidence.length === 0 ? (
              <div className="flex flex-col gap-2.5 rounded-control border border-dashed border-control bg-canvas p-3.5">
                <label htmlFor="bk-proof-file" className="font-semibold text-ink">
                  Acceptance file
                </label>
                <input
                  key={key}
                  id="bk-proof-file"
                  type="file"
                  accept={EVIDENCE_MIME_TYPES.join(',')}
                  aria-describedby="bk-proof-hint"
                  disabled={busy}
                  onChange={(e) => void upload(e.target.files?.[0])}
                  className={cn('block w-full text-base text-ink file:mr-3 file:cursor-pointer file:rounded-control file:border file:border-line-strong file:bg-card file:px-3 file:py-1.5 file:font-semibold file:text-ink', focusRing)}
                />
                <p id="bk-proof-hint" className="m-0 text-sm text-quiet" aria-live="polite">
                  {busy ? 'Uploading…' : 'Screenshot or PDF of the customer saying yes. PDF, JPG, PNG or WebP, up to 4 MB.'}
                </p>
              </div>
            ) : null}
            {problem ? (
              <p role="alert" className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {problem}
              </p>
            ) : null}
          </>
        )}
      </SectionBody>
    </SectionCard>
  );
}

function Collapsed({ id, summary, children }: { id?: string; summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <details id={id} className="group/col rounded-card border border-line bg-card shadow-card">
      <summary className={cn('flex cursor-pointer list-none items-center gap-2 rounded-card px-5 py-4 font-semibold text-ink max-sm:px-4 [&::-webkit-details-marker]:hidden', focusRing)}>
        <ChevronRight aria-hidden="true" className="size-4 text-quiet transition-transform group-open/col:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="border-t border-line p-5 max-sm:p-4">{children}</div>
    </details>
  );
}

/** "Payment already received? (optional)", collapsed: the live payment report, unchanged. */
export function ClaimCard({ view, actions }: { view: BookNowView; actions: BookingFormActions }) {
  if (!view.claims) return null;
  return (
    <Collapsed
      id="sec-claim"
      summary={
        <>
          Payment already received? <span className="font-normal text-quiet">(optional)</span>
        </>
      }
    >
      <SalesClaimsPanel dealId={view.dealId} claims={view.claims} reportAction={actions.reportClaim} withdrawAction={actions.withdrawClaim} headingLevel={4} />
    </Collapsed>
  );
}

/** "Review trip and services", collapsed. */
export function ReviewCard({ vm, view, travellersText }: { vm: BookingFormVM; view: BookNowView; travellersText: string | null }) {
  const { go } = useFormStep();
  const c = view.contacts;
  const counts = SERVICE_CHIPS.map((s) => ({ label: s.label, n: vm.items.filter((i) => i.serviceType === s.type).length })).filter((s) => s.n > 0);
  return (
    <Collapsed summary="Review trip and services">
      <span id="review" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <b>Customer</b>
          <p className="m-0 text-sm text-quiet">
            {c?.contactName || '—'} · {c?.mobile || c?.email || '—'}
          </p>
          <p className="m-0 text-sm text-quiet">
            {vm.trip.destination || '—'} · {vm.trip.start ? dateText(vm.trip.start) : '—'}
            {vm.trip.end ? ` – ${dateText(vm.trip.end)}` : ''}
          </p>
          <p className="m-0 text-sm text-quiet">{travellersText ?? '—'}</p>
          <Button variant="link" className="mt-1.5" onClick={() => go('travellers')}>
            <Pencil aria-hidden="true" />
            Edit<span className="sr-only"> customer and passengers</span>
          </Button>
        </div>
        <div>
          <b>Services</b>
          <ul className="m-0 my-1 pl-4.5 text-sm text-quiet">
            {counts.length > 0 ? (
              counts.map((s) => (
                <li key={s.label}>
                  {s.label}: {s.n}
                </li>
              ))
            ) : (
              <li>No services added.</li>
            )}
          </ul>
          <Button variant="link" onClick={() => go('stay')}>
            <Pencil aria-hidden="true" />
            Edit<span className="sr-only"> services</span>
          </Button>
        </div>
      </div>
    </Collapsed>
  );
}

/** The submit card: the note, the live submit with its confirmation, and "Finish N things first". */
export function SubmitCard({ view, actions, left, reloadHref, onShowList }: { view: BookNowView; actions: BookingFormActions; left: number; reloadHref: string; onShowList: () => void }) {
  const editable = editableOf(view);
  const version = view.version;
  const revision = Boolean(version?.revisesVersionId);
  const reason = submitBlockedReason(view);
  const canSubmit = editable && view.canSubmit && left === 0 && view.checklist.every((i) => !i.blocking) && Boolean(version);
  return (
    <section aria-label="Submit" className="flex flex-col gap-3 rounded-card border border-line bg-card px-5 py-4.5 shadow-card max-sm:px-4">
      {revision && version ? <ChangeClassForm view={view} action={actions.classifyRevision} reloadHref={reloadHref} /> : null}
      <div className="flex gap-2.5 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-sm text-copy">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
        <p className="m-0">
          {revision
            ? 'Saving the fixed booking replaces the returned version. Accounts checks it again; departments keep their tasks. Nothing is booked or paid.'
            : 'Submitting locks this version and creates one task per service.'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {version ? <SubmitBookingForm view={view} disabled={!canSubmit} describedBy="bf-submit-reason" action={actions.submit} reloadHref={reloadHref} triggerId={SUBMIT_TRIGGER_ID} /> : null}
        {revision && editable && version ? <DiscardRevisionForm view={view} action={actions.discardRevision} /> : null}
        <span id="bf-submit-reason" className="text-sm text-quiet">
          {left > 0 ? (
            <>
              Finish {left} {left === 1 ? 'thing' : 'things'} first (see{' '}
              <button type="button" onClick={onShowList} className={cn('cursor-pointer border-0 bg-transparent p-0 text-sm text-brand-strong underline underline-offset-4', focusRing)}>
                the list at the top
              </button>
              ).
            </>
          ) : (
            reason
          )}
        </span>
      </div>
    </section>
  );
}

export { newRequestId };
