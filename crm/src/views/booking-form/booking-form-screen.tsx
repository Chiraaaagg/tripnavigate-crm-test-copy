'use client';

import { ArrowLeft, ArrowRight, CalendarDays, ChevronLeft, Compass, Lock, MapPin, ReceiptText, Users } from 'lucide-react';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { BOOKING_FORM_STEP_LABEL } from '@/modules/fulfilment/booking-form-contract';
import { formatInr, partyFromSaved, tripNights } from '@/modules/fulfilment/booking-form-model';
import { PREFILL_FIELD } from '@/modules/fulfilment/b11-forms';
import { dateText } from '../b11/book-fields';
import { DraftSyncProvider, useDraftSync, useSectionForm } from '../b11/draft-sync';
import { PrefillInlineProvider } from '../b11/prefill-inline';
import { AUTOSAVE_LABEL, AUTOSAVE_TARGET, SaveQueueProvider, useSaveQueue, type AutosaveKey } from './autosave-queue';
import { ClaimCard, OkCard, PlanCard, ReviewCard, SubmitCard } from './before-submit';
import { BillToCard } from './bill-to-card';
import { countsOf, CustomerTripCard, customerInitial, customerIssues, dealBacked, travellersText, type CustomerValues } from './customer-trip-card';
import { FormToastProvider } from './form-toast';
import { PackagePriceCard, PriceLockedCard } from './package-price-card';
import { PassengersCard } from './passengers-card';
import type { PassengerRow } from './passenger-drawer';
import { ReadyList, readyItems, type ReadyKey } from './ready-list';
import { RefreshDialog } from './refresh-dialog';
import { SERVICE_CHIPS } from './service-labels';
import { isScreenshotFlight, legsOf } from './service-model';
import { ServicesStep } from './services-step';
import type { ServiceType } from '@/modules/fulfilment/contracts';
import { FormStepProvider, stepHeadingId, useFormStep } from './step-context';
import { StepsBar, type StepState } from './steps-bar';
import { editableOf } from './form-helpers';
import { FORM_STEPS, type BookingFormScreenProps, type FormStep } from './types';

/*
 * The booking form, Book now v2 (owner-approved prototype of 26 October 2026,
 * docs/implementation/booking-form-v2-2026-10-26/). Three steps on one client
 * screen inside the staff frame: the step bar with a tick, warning or alert
 * per step, the cards, the booking summary beside them on wide screens, and a
 * footer that moves between steps without blocking and says what is not
 * saved ("Not saved: Package price · Go to fix"). Cards save themselves
 * through one page-level save queue; service drawers keep their Save button.
 * The browser keeps unsaved entries only while the page is open; the
 * leave-page warning stays.
 */

const SINGULAR: Record<string, [string, string]> = { hotel: ['hotel', 'hotels'], transfer: ['car', 'cars'], flight: ['flight', 'flights'], activity: ['activity', 'activities'], visa: ['visa', 'visas'], passport: ['passport', 'passports'] };
const STEP_OF_KEY: Record<AutosaveKey, FormStep> = { customer: 'travellers', passengers: 'travellers', fares: 'stay', price: 'finish', billTo: 'finish', plan: 'finish' };

export function BookingFormScreen(props: BookingFormScreenProps) {
  const { vm, view, links, prefillUi = null, actions } = props;
  const editable = editableOf(view);
  const hrefs = links.steps as Record<FormStep, string>;
  const auto = vm.prefillMode === 'auto' && prefillUi?.mode === 'inline';
  const segment = useSelectedLayoutSegment();
  const initialStep: FormStep = (FORM_STEPS as readonly string[]).includes(segment ?? '') ? (segment as FormStep) : vm.initialStep;
  // Owner ruling: passive "From Bitrix" markers only; no per-value "Bitrix now says … Use it / Keep mine".
  const markersOnly = useMemo(() => (prefillUi?.mode === 'inline' ? { ...prefillUi, sections: prefillUi.sections.map((sec) => ({ ...sec, notices: [] })) } : null), [prefillUi]);
  return (
    <DraftSyncProvider view={view}>
      <PrefillInlineProvider
        ui={auto ? markersOnly : null}
        panel={null}
        target="booking_version"
        versionId={view.version?.versionId ?? ''}
        dealId={view.dealId}
        rowVersion={view.version?.rowVersion ?? 0}
        editable={editable}
        actions={{ fillEmpty: actions.fillEmptyPrefill }}
        reloadHref={links.reload}
      >
        <FormStepProvider initialStep={initialStep} hrefs={hrefs}>
          <SaveQueueProvider scope={view.version?.versionId ?? view.dealId}>
            <FormToastProvider>
              <ScreenBody {...props} />
              {auto ? <AutoFillOnOpen {...props} /> : null}
            </FormToastProvider>
          </SaveQueueProvider>
        </FormStepProvider>
      </PrefillInlineProvider>
    </DraftSyncProvider>
  );
}

/** Switch on: one automatic "fill empty fields" run when the page opens with nothing unsaved (change 15). */
function AutoFillOnOpen({ view, prefillUi, actions }: BookingFormScreenProps) {
  const sync = useDraftSync();
  const queue = useSaveQueue();
  const ran = useRef(false);
  const f = useSectionForm({
    id: 'bf-auto-fill',
    section: 'customer',
    label: 'Automatic filling',
    order: 0,
    action: actions.fillEmptyPrefill ?? actions.saveCustomer,
    initial: {},
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: false,
  });
  const { post } = f;
  const offered = prefillUi?.mode === 'inline' && prefillUi.fillEmpty.offered && !prefillUi.fillEmpty.disabledReason;
  useEffect(() => {
    if (ran.current || !offered || !actions.fillEmptyPrefill || sync.anyDirty || !editableOf(view)) return;
    ran.current = true;
    const fd = new FormData();
    fd.set(PREFILL_FIELD.target, 'booking_version');
    fd.set('versionId', view.version?.versionId ?? '');
    fd.set('dealId', view.dealId);
    void queue.run(() => post(fd));
  }, [offered, actions.fillEmptyPrefill, sync.anyDirty, view, post, queue]);
  return null;
}

function ScreenBody({ vm, view, actions, links, ownerText, vn }: BookingFormScreenProps) {
  const { step, go, focusField, hrefs } = useFormStep();
  const queue = useSaveQueue();
  const reload = hrefs[step];
  const editable = editableOf(view);
  const dealFacts = vn?.dealFacts !== undefined ? vn.dealFacts : (vm.dealFacts ?? null);
  const from = dealBacked(dealFacts);
  const [customer, setCustomer] = useState<CustomerValues>(() => customerInitial(vm, view, dealFacts));
  const onCustomer = useCallback((v: CustomerValues) => setCustomer(v), []);
  const [paxState, setPaxState] = useState<{ rows: PassengerRow[]; slots: number; firstBlank: number | null } | null>(null);
  const onRows = useCallback((rows: PassengerRow[], slots: number, firstBlank: number | null) => setPaxState({ rows, slots, firstBlank }), []);
  const [liveTotal, setLiveTotal] = useState<{ paise: string | null; settled: boolean; gap: string | null }>({ paise: vm.prices?.sellingTotalPaise ?? null, settled: true, gap: null });
  const onTotal = useCallback((paise: string | null, settled: boolean, gap: string | null) => setLiveTotal({ paise, settled, gap }), []);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [correctOpener, setCorrectOpener] = useState<HTMLElement | null>(null);
  const openCorrect = () => {
    setCorrectOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCorrectOpen(true);
  };
  const [chosen, setChosen] = useState<ServiceType[]>(() => SERVICE_CHIPS.map((c) => c.type).filter((t) => vm.items.some((i) => i.serviceType === t)));

  const n = countsOf(customer);
  const name = customer.contactName.trim() || view.contacts?.contactName || '';
  const nights = tripNights(customer.start || null, customer.end || null);
  const savedParty = partyFromSaved(vm.party);
  const countsSaved = vm.party.total !== null && n.total !== null && savedParty.total === n.total && (savedParty.children ?? 0) === n.c && (savedParty.infants ?? 0) === n.i;
  const named = paxState ? paxState.rows.filter((r) => r.name.trim()).length : view.travellers.length;
  const slots = paxState?.slots ?? n.total ?? 0;
  const items = vm.items;
  const typedFlights = items.filter((i) => i.serviceType === 'flight' && !isScreenshotFlight(i.facts));
  const flightFlags = typedFlights.filter((i) => {
    const g = legsOf(i.facts)[0];
    return !g?.flightNo || !g?.departTime;
  }).length;

  // The seven "Before you submit" items: the screen's own state merged with the server's readiness.
  const custIssues = customerIssues(customer, dealFacts);
  // Prototype svcIssues: a chosen service with no rows counts, even when it is only a chip choice.
  const svcIssues = serviceStepIssues(chosen, items);
  const unnamedIndex = paxState ? paxState.firstBlank : slots > named ? named + 1 : null;
  const rawTotal = liveTotal.paise ?? vm.prices?.sellingTotalPaise ?? view.commercials?.sellingTotalPaise ?? null;
  // Nobody priced yet is "Not worked out yet", never ₹0.
  const total = rawTotal && BigInt(rawTotal) > 0n ? rawTotal : null;
  const cards = queue.cards;
  const ready = readyItems(vm.checklist, {
    s1: { done: custIssues.length === 0 && unnamedIndex === null && cards.customer?.state !== 'fix' && cards.passengers?.state !== 'fix', why: custIssues[0] ?? (unnamedIndex !== null ? `Passenger ${unnamedIndex}: full name as on the ID.` : null) },
    // Stored data (ID proof, Bill To, plan, the customer's yes): the server's readiness decides, so the list never
    // counts as missing what the server says is fine; the screen adds only a card that is saving or needs a fix.
    // As the prototype: nothing to prove before anyone travels (the server decides the rest).
    id: { done: slots > 0, why: 'Attach ID proof on step 1' },
    s2: { done: svcIssues.length === 0, why: svcIssues[0] ?? null },
    price: { done: !vm.prices || (liveTotal.settled && total !== null && cards.price?.state !== 'fix'), why: liveTotal.gap ?? (!countsSaved ? 'Save step 1 first. Prices follow the saved traveller counts.' : 'Fill the final sale per person') },
    bill: { done: cards.billTo?.state !== 'fix' && cards.billTo?.state !== 'saving', why: cards.billTo?.reason ?? 'Choose or add the customer to bill' },
    plan: { done: cards.plan?.state !== 'fix' && cards.plan?.state !== 'saving', why: cards.plan?.reason ?? 'Instalments must add up to the total' },
    ok: { done: true, why: 'Upload the customer’s yes' },
  });
  const left = ready.filter((r) => !r.done).length;
  const s2Bad = ready.find((r) => r.key === 's2')!.done === false;
  const status: Record<FormStep, StepState> = {
    // As the prototype's stepState: customer and passenger names only (ID proof shows in step 3's list).
    travellers: ready.find((r) => r.key === 's1')!.done ? 'ok' : 'bad',
    stay: s2Bad ? 'bad' : flightFlags > 0 || vm.checklist.some((r) => !r.blocking && r.section === 'services') ? 'warn' : 'ok',
    finish: left === 0 ? 'ok' : 'bad',
  };
  const goReady = (key: ReadyKey) => {
    if (key === 's1' || key === 'id') go('travellers');
    else if (key === 's2') go('stay');
    else focusField(key === 'price' ? 'price-heading' : key === 'bill' ? 'billTo-heading' : key === 'plan' ? 'plan-heading' : 'ok-heading');
  };

  // Footer: what is not saved, in words, with a link to the first card to fix.
  const fixes = (Object.entries(cards) as Array<[AutosaveKey, { state: string }]>).filter(([, s]) => s.state === 'fix');
  const saving = queue.pending > 0 || Object.values(cards).some((s) => s?.state === 'saving');
  const goFix = (key: AutosaveKey) => {
    const target = AUTOSAVE_TARGET[key];
    if (STEP_OF_KEY[key] !== step) go(STEP_OF_KEY[key], { fieldId: `${target}-heading` });
    else if (!focusField(`${target}-heading`)) focusField(target);
  };
  const stepIndex = FORM_STEPS.indexOf(step);
  const back = stepIndex > 0 ? FORM_STEPS[stepIndex - 1] : null;
  const next = stepIndex < 2 ? FORM_STEPS[stepIndex + 1] : null;
  const serviceCounts = SERVICE_CHIPS.map((c) => ({ type: c.type, n: items.filter((i) => i.serviceType === c.type).length })).filter((c) => c.n > 0);
  const travellers = n.a !== null ? travellersText(n.a, n.c, n.i) : null;
  const source = dealFacts ? 'Deal from Bitrix' : view.dealReference;
  const statusLine = [source, vm.statusLine.state, vm.statusLine.owner ?? (ownerText ? `Owner: ${ownerText}` : null)].filter(Boolean).join(' · ');

  const stepBox = (key: FormStep, children: ReactNode) => (
    <section key={key} data-form-step={key} aria-labelledby={stepHeadingId(key)} hidden={step !== key} className={cn('flex min-w-0 flex-col gap-4.5', step !== key && 'hidden')}>
      <h2 id={stepHeadingId(key)} tabIndex={-1} className="sr-only">
        Step {FORM_STEPS.indexOf(key) + 1} of 3: {BOOKING_FORM_STEP_LABEL[key]}
      </h2>
      {children}
    </section>
  );

  return (
    <div className="font-sans text-base text-copy">
      <Link href={links.deal} className={cn('mb-3 inline-flex items-center gap-1 rounded-chip font-semibold text-brand-strong no-underline hover:underline', focusRing)}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to the deal
      </Link>
      <h1 id="book-heading" tabIndex={-1} className="m-0 text-2xl font-semibold tracking-[-0.02em] wrap-anywhere text-ink outline-none max-sm:text-xl">
        Book now{name ? ` · ${name}` : ''}
      </h1>
      <p className="m-0 mt-[0.25rem] text-sm text-quiet">
        <span className="sr-only">Status: </span>
        {statusLine}
      </p>
      <p className="m-0 mt-0.5 text-sm text-copy">{left > 0 ? `Next: finish ${left} ${left === 1 ? 'thing' : 'things'} (marked in the steps)` : 'Next: review and submit (step 3)'}</p>
      {view.dealNotActive ? (
        <Notice tone="warning" className="mt-[0.5rem]">
          This deal is lost or rejected in Bitrix, so the booking cannot change.
        </Notice>
      ) : !view.canEdit ? (
        <p className="m-0 mt-[0.25rem] flex gap-2 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          View only. The deal owner, assigned Sales or branch Manager can change it.
        </p>
      ) : null}

      <StepsBar status={status} />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_14.75rem]">
        <div className="flex min-w-0 flex-col gap-4.5">
          {stepBox(
            'travellers',
            <>
              <CustomerTripCard vm={vm} view={view} action={actions.saveCustomer} onValues={onCustomer} dealFacts={dealFacts} onCorrect={openCorrect} />
              <PassengersCard
                view={view}
                counts={{ adults: n.a, children: n.c, infants: n.i }}
                countsLocked={from.adults}
                onRows={onRows}
                onMorePax={openCorrect}
                copyApplies={vm.idProofCopyApplies}
                actions={{ saveTravellers: actions.saveTravellers, saveIdentity: actions.saveIdentity, uploadIdProof: actions.uploadIdProof, removeIdProof: actions.removeIdProof, retryIdProofCopy: actions.retryIdProofCopy }}
              />
            </>,
          )}
          {stepBox(
            'stay',
            <ServicesStep selected={chosen} setSelected={setChosen} vm={vm} view={view} actions={actions} party={{ total: n.total, children: n.c, infants: n.i }} tripStart={customer.start} tripEnd={customer.end} searchHotels={vn?.searchHotels ?? null} />,
          )}
          {stepBox(
            'finish',
            <>
              <ReadyList items={ready} onGo={goReady} />
              {vm.prices ? <PackagePriceCard prices={vm.prices} view={view} party={savedParty} countsSaved={countsSaved} action={actions.savePrices} onTotal={onTotal} onGoStep1={() => go('travellers')} /> : <PriceLockedCard />}
              <BillToCard billTo={vm.billTo} view={view} action={actions.saveBillTo} contact={{ name: customer.contactName, phone: customer.mobile, email: customer.email }} parties={vn?.parties ?? null} />
              {view.commercials ? <PlanCard view={view} action={actions.savePlan} totalPaise={total} /> : null}
              <OkCard view={view} actions={actions} />
              <ClaimCard view={view} actions={actions} />
              <ReviewCard vm={vm} view={view} travellersText={travellers} />
              <SubmitCard view={view} actions={actions} left={left} reloadHref={reload} onShowList={() => focusField('bf-ready-heading')} />
            </>,
          )}
        </div>
        <aside aria-label="Booking summary" className="sticky top-19 hidden rounded-card border border-line bg-card p-4.5 shadow-card xl:block">
          <h2 className="m-0 mb-3 text-base font-semibold text-ink">Booking summary</h2>
          <SummaryItem icon={MapPin} label="Destination" value={customer.destination || 'Not entered'} />
          <SummaryItem icon={CalendarDays} label="Travel date" value={customer.start ? `${dateText(customer.start)}${nights !== null ? ` · ${nights} ${nights === 1 ? 'night' : 'nights'}` : ''}` : 'Not entered'} />
          <SummaryItem icon={Users} label="Passengers" value={travellers ?? 'Not entered'} />
          {serviceCounts.length > 0 ? <SummaryItem icon={Compass} label="Services" value={serviceCounts.map((c) => `${c.n} ${SINGULAR[c.type]![c.n === 1 ? 0 : 1]}`).join(' · ')} /> : null}
          {step === 'finish' && vm.prices ? <SummaryItem icon={ReceiptText} label="Package selling total" value={total ? formatInr(total) : 'Not worked out yet'} /> : null}
        </aside>
      </div>

      {/* Room for the fixed footer (prototype: 120 px under the content). */}
      <div aria-hidden="true" className="h-30 max-sm:h-32" />
      <div data-slot="step-footer" className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-4 border-t border-line bg-card/97 px-8 py-3 max-lg:px-5 max-sm:flex-col max-sm:items-stretch max-sm:gap-2 max-sm:px-3.5 max-sm:py-2.5 lg:left-64">
        {/* Only the save state is announced, when it changes (not every keystroke). */}
        <span className="sr-only" aria-live="polite">
          {!editable ? '' : fixes.length > 0 ? `Not saved: ${fixes.map(([k]) => AUTOSAVE_LABEL[k]).join(', ')}` : saving ? '' : 'All changes saved'}
        </span>
        <p className="m-0 min-w-0 text-sm text-quiet">
          Step {stepIndex + 1} of 3 ·{' '}
          {!editable ? (
            'View only'
          ) : fixes.length > 0 ? (
            <>
              Not saved: {fixes.map(([k]) => AUTOSAVE_LABEL[k]).join(', ')} ·{' '}
              <button type="button" onClick={() => goFix(fixes[0]![0])} className={cn('cursor-pointer border-0 bg-transparent p-0 font-semibold text-brand-strong hover:underline', focusRing)}>
                Go to fix
              </button>
            </>
          ) : saving ? (
            'Saving…'
          ) : (
            'All changes saved'
          )}
          {step === 'stay' && svcIssues.length > 0 ? <span className="text-status-warning"> · {svcIssues[0]}</span> : null}
        </p>
        <div className="flex justify-end gap-2.5">
          {back ? (
            <Button size="lg" onClick={() => go(back)}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
          ) : null}
          {next ? (
            <Button variant="primary" size="lg" onClick={() => go(next)}>
              Go to step {stepIndex + 2}
              <ArrowRight aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => focusField('bf-ready-heading')}>
              Review and submit
            </Button>
          )}
        </div>
      </div>
      <RefreshDialog open={correctOpen} onOpenChange={setCorrectOpen} dealId={view.dealId} dealHref={dealFacts?.bitrixDealHref ?? null} refresh={actions.refreshFromBitrix} returnFocusTo={correctOpener} />
    </div>
  );
}

/** Step 2 problems in the prototype's words (svcIssues), before the server's readiness. */
export function serviceStepIssues(chosen: readonly ServiceType[], items: ReadonlyArray<{ serviceType: ServiceType }>): string[] {
  const on = SERVICE_CHIPS.filter((c) => chosen.includes(c.type) || items.some((i) => i.serviceType === c.type));
  if (on.length === 0) return ['Add at least one service.'];
  return on.filter((c) => !items.some((i) => i.serviceType === c.type)).map((c) => `${c.label}: add one, or untick it.`);
}

function SummaryItem({ icon: Icon, label, value }: { icon: typeof MapPin; label: string; value: string }) {
  return (
    <div className="my-3 flex items-start gap-2.25 text-sm">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
      <div className="min-w-0">
        <div>{label}</div>
        <div className="font-medium wrap-anywhere text-ink">{value}</div>
      </div>
    </div>
  );
}
