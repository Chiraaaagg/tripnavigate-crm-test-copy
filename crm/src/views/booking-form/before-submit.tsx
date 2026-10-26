'use client';

import { CircleCheck, CircleX, Pencil, TriangleAlert, UserRound, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { BOOKING_FORM_STEP_LABEL, type BookingFormSection } from '@/modules/fulfilment/booking-form-contract';
import type { BookingFormChecklistItem, BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import { BOOKING_FORM_FIELD_ID } from '@/modules/fulfilment/booking-form-model';
import { dateText } from '../b11/book-fields';
import { SalesClaimsPanel } from '../b11/book-claims';
import { AcceptanceUploadForm, ChangeClassForm, DiscardRevisionForm, ProofRow, SubmitBookingForm } from '../b11/book-review';
import { PlanSection } from '../b11/book-steps';
import { QuotationSourceNote } from '../b11/quotation-source';
import type { BookNowView } from '../b11/shapes';
import { editableOf } from './form-helpers';
import { SectionBody, SectionCard } from './parts';
import { RowFor, SERVICE_ICON } from './services-step';
import { SERVICE_CHIPS } from './service-labels';
import { useFormStep } from './step-context';
import { TYPE_TEXT } from './passengers-card';
import type { BookingFormActions } from './types';

/*
 * Step 3 · "Before you submit" (contract §2.3): one closed group holding what
 * the preview left out but the booking still needs: what blocks submission,
 * the payment plan, payments the customer reported, the customer's written
 * acceptance (and the change class of a returned booking), the final review
 * of trip and services (closed), and the existing submit with its
 * confirmation. Opened by the footer's "Review and submit" and by any link
 * to a field inside it.
 */

export const SUBMIT_TRIGGER_ID = 'bf-submit-trigger';
export const BEFORE_SUBMIT_ID = 'bf-before-submit';

/** Where a checklist link lands when the row names no field: the section's heading. */
export const SECTION_TARGET: Record<BookingFormSection, string> = {
  customer: 'customer-heading',
  passengers: 'passengers-heading',
  services: BOOKING_FORM_FIELD_ID.services,
  price: 'price-heading',
  billTo: 'billTo-heading',
  submit: 'bf-submit-heading',
};

/** A row naming a passenger opens that passenger's Details (Echo B-M1); otherwise its field or section heading. */
function targetOf(r: BookingFormChecklistItem, rowOfSeq: Map<number, number>): string {
  const row = r.travellerSeqs.length > 0 ? rowOfSeq.get(r.travellerSeqs[0]!) : undefined;
  if (row !== undefined && (r.section === 'passengers' || r.fieldId === BOOKING_FORM_FIELD_ID.passengers)) return `passengers-${row}-details`;
  return r.fieldId ?? SECTION_TARGET[r.section];
}

function CheckLines({ rows, tone, rowOfSeq }: { rows: BookingFormChecklistItem[]; tone: 'blocking' | 'warning'; rowOfSeq: Map<number, number> }) {
  const Icon = tone === 'blocking' ? CircleX : TriangleAlert;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {rows.map((r, i) => (
        <li key={`${r.code}-${r.section}-${i}`} className="m-0 flex gap-2.5">
          <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tone === 'blocking' ? 'text-status-danger' : 'text-status-warning')} />
          <span className="min-w-0">
            <span className="sr-only">{tone === 'blocking' ? 'Blocking: ' : 'Check: '}</span>
            <a href={`#${targetOf(r, rowOfSeq)}`} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
              {BOOKING_FORM_STEP_LABEL[r.step]}
            </a>
            {': '}
            {r.travellerSeqs.length > 0 ? `passenger ${r.travellerSeqs.join(', ')}: ` : ''}
            {r.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function submitBlockedReason(view: BookNowView): string | null {
  const blocking = view.checklist.filter((i) => i.blocking);
  const stageWaiting = blocking.some((i) => i.code === 'stage_not_confirmed');
  if (!view.version) return 'Start the booking draft first.';
  if (view.dealNotActive) return 'This deal is lost or rejected in Bitrix, so the booking cannot change.';
  if (stageWaiting && blocking.length === 1) return 'Waiting for Won - Payment Received in Bitrix. You can keep preparing.';
  if (blocking.length > 0) return `Finish ${blocking.length} ${blocking.length === 1 ? 'thing' : 'things'} first.`;
  if (!view.canSubmit) return view.submitBlockedReason ?? 'Only the deal owner or the branch Manager can submit this booking.';
  return null;
}

export function BeforeSubmit({ vm, view, actions, reloadHref }: { vm: BookingFormVM; view: BookNowView; actions: BookingFormActions; reloadHref: string }) {
  const version = view.version;
  const editable = editableOf(view);
  const revision = Boolean(version?.revisesVersionId);
  const rowOfSeq = new Map([...view.travellers].sort((a, b) => a.seq - b.seq).map((t, i) => [t.seq, i + 1]));
  const blocking = vm.checklist.filter((r) => r.blocking);
  const warnings = vm.checklist.filter((r) => !r.blocking);
  const reason = submitBlockedReason(view);
  const canSubmit = editable && view.canSubmit && blocking.length === 0 && Boolean(version);
  const evidence = view.evidence.filter((e) => e.status !== 'removed');
  const stale = view.checklist.some((i) => i.code === 'quote_acceptance_stale');
  return (
    <details id={BEFORE_SUBMIT_ID} className="group/bs rounded-card border border-line bg-card shadow-card">
      <summary className={cn('flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-5 py-4 font-semibold text-copy max-sm:px-4 [&::-webkit-details-marker]:hidden', focusRing)}>
        <span id="bf-submit-heading" className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block transition-transform group-open/bs:rotate-90 motion-reduce:transition-none">
            ▸
          </span>
          Before you submit
        </span>
        <span className="text-sm font-normal text-quiet">{blocking.length === 0 ? 'Ready to submit' : `${blocking.length} ${blocking.length === 1 ? 'item' : 'items'} to finish`}</span>
      </summary>
      <div className="flex flex-col gap-6 border-t border-line px-5 py-5 max-sm:px-4">
        <section aria-labelledby="review-heading" className="flex flex-col gap-3">
          {/* Old links to #review land here. */}
          <span id="review" />
          <h4 id="review-heading" className="m-0 text-base font-semibold text-ink">
            To finish before submitting <span className="font-normal text-quiet">({blocking.length})</span>
          </h4>
          {blocking.length === 0 ? (
            <p className="m-0 flex items-center gap-2 text-copy">
              <CircleCheck aria-hidden="true" className="size-4 text-status-success" /> Ready to submit
            </p>
          ) : (
            <CheckLines rows={blocking} tone="blocking" rowOfSeq={rowOfSeq} />
          )}
          {warnings.length > 0 ? (
            <>
              <h4 className="m-0 text-base font-semibold text-ink">
                Worth checking <span className="font-normal text-quiet">({warnings.length})</span>
              </h4>
              <CheckLines rows={warnings} tone="warning" rowOfSeq={rowOfSeq} />
            </>
          ) : null}
        </section>

        <section id="bf-plan" tabIndex={-1} aria-labelledby="payment-heading" className="flex flex-col gap-3 border-t border-line pt-5 outline-none">
          {/* Old links to #payment land here. */}
          <span id="payment" />
          <h4 id="payment-heading" className="m-0 text-base font-semibold text-ink">
            Payment plan
          </h4>
          {view.commercials ? (
            <PlanSection view={view} reloadHref={reloadHref} saveAction={actions.savePlan} />
          ) : (
            <p className="m-0 text-quiet">The payment plan is filled by Sales on this deal.</p>
          )}
        </section>

        {view.claims ? (
          <div className="border-t border-line pt-5">
            <SalesClaimsPanel dealId={view.dealId} claims={view.claims} reportAction={actions.reportClaim} withdrawAction={actions.withdrawClaim} headingLevel={4} />
          </div>
        ) : null}

        {revision && version ? (
          <div className="border-t border-line pt-5">
            <ChangeClassForm view={view} action={actions.classifyRevision} reloadHref={reloadHref} />
          </div>
        ) : null}

        <section id="bf-acceptance" tabIndex={-1} aria-labelledby="bf-acceptance-heading" className="flex flex-col gap-3 border-t border-line pt-5 outline-none">
          <h4 id="bf-acceptance-heading" className="m-0 text-base font-semibold text-ink">
            Customer’s written OK for this version
          </h4>
          <p className="m-0 text-sm text-quiet">A Bitrix stage is not proof. If you change anything after uploading, upload a new OK.</p>
          <QuotationSourceNote source={view.quotationSource} stale={stale} />
          {!view.evidenceVisible ? (
            <Notice tone="locked">Only Sales on this deal and the branch Manager can open proof files.</Notice>
          ) : evidence.length === 0 ? (
            view.quotationSource && !stale ? null : <p className="m-0 text-copy">No acceptance uploaded yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Proof files">
              {evidence.map((e) => (
                <ProofRow key={e.id} item={e} dealId={view.dealId} editable={editable} action={actions.removeEvidence} />
              ))}
            </ul>
          )}
          {editable && version && view.evidenceVisible ? <AcceptanceUploadForm dealId={view.dealId} versionId={version.versionId} fileCount={evidence.length} action={actions.uploadEvidence} /> : null}
        </section>

        <FinalReview vm={vm} view={view} />

        <section aria-label="Submit" className="flex flex-col gap-3 border-t border-line pt-5">
          <Notice tone="info">
            <p>
              {revision
                ? 'Saving the fixed booking replaces the returned version. Accounts checks it again; departments keep their tasks. Nothing is booked or paid.'
                : 'Submitting locks this version and creates one task per service.'}
            </p>
          </Notice>
          {reason ? (
            <p id="bf-submit-reason" className="m-0 text-copy">
              {reason}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {revision && editable && version ? <DiscardRevisionForm view={view} action={actions.discardRevision} /> : null}
            {version ? <SubmitBookingForm view={view} disabled={!canSubmit} describedBy={reason ? 'bf-submit-reason' : undefined} action={actions.submit} reloadHref={reloadHref} triggerId={SUBMIT_TRIGGER_ID} /> : null}
          </div>
        </section>
      </div>
    </details>
  );
}

/** Closed "Review trip and services" (preview): customer, passengers and services, each with Edit. */
function FinalReview({ vm, view }: { vm: BookingFormVM; view: BookNowView }) {
  const { go } = useFormStep();
  const c = view.contacts;
  const items = [...vm.items].sort((a, b) => a.itemNo - b.itemNo);
  const estimatesVisible = view.commercials !== undefined;
  const edit = (step: 'travellers' | 'stay', what: string) => (
    <Button variant="ghost" size="sm" onClick={() => go(step)} aria-label={`Edit ${what}`}>
      <Pencil aria-hidden="true" />
      Edit
    </Button>
  );
  return (
    <details className="group/rv rounded-card border border-line bg-card">
      <summary className={cn('cursor-pointer rounded-card px-5 py-4 font-semibold text-copy max-sm:px-4', focusRing)}>Review trip and services</summary>
      <div className="flex flex-col gap-4 px-5 pb-5 max-sm:px-4">
        <SectionCard id="bf-review-customer" title="Customer" icon={UserRound} action={edit('travellers', 'customer')}>
          <SectionBody>
            <dl className="m-0 grid gap-3 text-base">
              {[
                ['Name', c?.contactName || 'Not entered'],
                ['Contact', [c?.mobile, c?.email].filter(Boolean).join(' · ') || 'Not entered'],
                ['Destination', vm.trip.destination || 'Not entered'],
                ['Travel', vm.trip.start ? `${dateText(vm.trip.start)}${vm.trip.end ? ` – ${dateText(vm.trip.end)}` : ''}` : 'Date not set'],
                ['Passengers', `${vm.party.total ?? 'Not set'}${view.travellers.length > 0 ? ` · ${view.travellers.length} named` : ''}`],
              ].map(([k, val]) => (
                <div key={k} className="flex items-baseline justify-between gap-5">
                  <dt className="text-quiet">{k}</dt>
                  <dd className="m-0 text-right wrap-anywhere text-ink">{val}</dd>
                </div>
              ))}
            </dl>
          </SectionBody>
        </SectionCard>
        {view.travellers.length > 0 ? (
          <SectionCard id="bf-review-passengers" title="Passenger list" icon={Users} count={view.travellers.length} action={edit('travellers', 'passengers')}>
            <SectionBody className="flex flex-col gap-3">
              {[...view.travellers]
                .sort((a, b) => a.seq - b.seq)
                .map((t, i) => (
                  <div key={t.seq} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span>
                      {i + 1}. {t.fullName || 'Name missing'}
                    </span>
                    <span className="text-sm text-quiet">
                      {TYPE_TEXT[t.type]}
                      {(t.idProofs ?? []).some((p) => p.status === 'stored') ? ' · ID proof attached' : ''}
                      {t.specialNeeds ? ' · Special request' : ''}
                    </span>
                  </div>
                ))}
            </SectionBody>
          </SectionCard>
        ) : null}
        {SERVICE_CHIPS.filter((s) => items.some((i) => i.serviceType === s.type)).map(({ type, label }) => {
          const rows = items.filter((i) => i.serviceType === type);
          return (
            <SectionCard key={type} id={`bf-review-${type}`} title={label} icon={SERVICE_ICON[type]} count={rows.length} action={edit('stay', label.toLowerCase())}>
              {rows.map((item) => (
                <div key={item.itemId} className="border-b border-line px-5 py-4 last:border-b-0 max-sm:px-4">
                  <RowFor item={item} estimatesVisible={estimatesVisible} />
                </div>
              ))}
            </SectionCard>
          );
        })}
        {items.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line p-5 text-quiet">
            No services added.
            <Button onClick={() => go('stay')}>Add services</Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
