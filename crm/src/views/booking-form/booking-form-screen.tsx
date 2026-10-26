'use client';

import { ArrowLeft, ArrowRight, CalendarDays, ChevronLeft, Lock, MapPin, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSelectedLayoutSegment } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { BOOKING_FORM_SECTION_STEP, BOOKING_FORM_STEP_LABEL, type BookingFormSection } from '@/modules/fulfilment/booking-form-contract';
import { BOOKING_FORM_FIELD_ID, customerIssues, formatInr, parseCount, serviceIssues, tripNights, type FormIssue } from '@/modules/fulfilment/booking-form-model';
import type { BookStepStatus } from '@/modules/fulfilment/contracts';
import { PREFILL_FIELD } from '@/modules/fulfilment/b11-forms';
import { saveReportText, saveRunReport, saveRunSummaryTitle, SUMMARY_ITEM_TEXT } from '@/modules/fulfilment/book-flow';
import type { ErrorSummaryItem } from '@/modules/fulfilment/book-flow-contract';
import { dateText } from '../b11/book-fields';
import { DraftSyncProvider, useDraftSync, useSectionForm, type SyncedEntry } from '../b11/draft-sync';
import { PageErrorSummary } from '../b11/error-summary';
import { PrefillInlineProvider } from '../b11/prefill-inline';
import { BEFORE_SUBMIT_ID, BeforeSubmit, SUBMIT_TRIGGER_ID } from './before-submit';
import { BillToCard } from './bill-to-card';
import { CustomerTripCard, countsProblem, customerInitial, dealBacked, effectiveAdults, typedParty, type CustomerValues } from './customer-trip-card';
import { PackagePriceCard, PriceLockedCard } from './package-price-card';
import { PassengersCard } from './passengers-card';
import type { PassengerRow } from './passenger-drawer';
import { SERVICE_CHIPS } from './service-labels';
import { SERVICE_ICON, ServicesStep } from './services-step';
import { FormStepProvider, stepHeadingId, useFormStep } from './step-context';
import { StepsBar } from './steps-bar';
import { editableOf } from './form-helpers';
import { FORM_STEPS, type BookingFormScreenProps, type FormStep } from './types';

/*
 * The booking form (owner-approved preview of 22 October 2026, contract
 * docs/implementation/booking-form-2026-10-22/contract.md). Three steps on one
 * client screen inside the real staff frame: horizontal steps, the form
 * stack, the booking summary beside it on wide screens, and a footer with
 * Back and one primary action. Every save goes through a server action; the
 * browser keeps unsaved entries only while the page is open (no browser
 * storage for business data).
 */

/** Summary counts: "1 hotel", "2 hotels" (the preview said "1 hotels"). */
const SINGULAR: Record<string, string> = { hotel: 'hotel', transfer: 'car', flight: 'flight', activity: 'activity', visa: 'visa', passport: 'passport' };
const SECTION_ORDER: readonly BookingFormSection[] = ['customer', 'passengers', 'services', 'price', 'billTo', 'submit'];
const STATE_RANK: Record<BookStepStatus, number> = { complete: 0, warnings_only: 1, needs_input: 2 };

function stepStatus(sectionStatus: Record<BookingFormSection, BookStepStatus> | undefined): Record<FormStep, BookStepStatus | undefined> {
  const out: Record<FormStep, BookStepStatus | undefined> = { travellers: undefined, stay: undefined, finish: undefined };
  if (!sectionStatus) return out;
  for (const s of SECTION_ORDER) {
    const st = sectionStatus[s];
    if (!st) continue;
    const step = BOOKING_FORM_SECTION_STEP[s];
    const cur = out[step];
    if (!cur || STATE_RANK[st] > STATE_RANK[cur]) out[step] = st;
  }
  return out;
}

export function BookingFormScreen(props: BookingFormScreenProps) {
  const { vm, view, links, prefillUi = null, actions } = props;
  const editable = editableOf(view);
  const hrefs = links.steps as Record<FormStep, string>;
  const auto = vm.prefillMode === 'auto' && prefillUi?.mode === 'inline';
  // Rendered by the booking layout: the address segment is the step; vm.initialStep is the fallback (gallery, older routes).
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
          <ScreenBody {...props} />
          {auto ? <AutoFillOnOpen {...props} /> : null}
        </FormStepProvider>
      </PrefillInlineProvider>
    </DraftSyncProvider>
  );
}

/** Switch on: one automatic "fill empty fields" run when the page opens with nothing unsaved (contract §2.12). */
function AutoFillOnOpen({ view, prefillUi, actions }: BookingFormScreenProps) {
  const sync = useDraftSync();
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
    void post(fd);
  }, [offered, actions.fillEmptyPrefill, sync.anyDirty, view, post]);
  return null;
}

function ScreenBody({ vm, view, actions, links, ownerText, vn }: BookingFormScreenProps) {
  const { step, go, focusField, hrefs } = useFormStep();
  // "Load the latest version" reloads the step on screen (links.reload is built for the first step).
  const reload = hrefs[step];
  const sync = useDraftSync();
  const router = useRouter();
  const editable = editableOf(view);
  // The loader's Deal facts (Terra, vm.dealFacts); the gallery may pass its own through `vn`.
  const dealFacts = vn?.dealFacts !== undefined ? vn.dealFacts : (vm.dealFacts ?? null);
  const [customer, setCustomer] = useState<CustomerValues>(() => customerInitial(vm, view, dealFacts));
  const onCustomer = useCallback((v: CustomerValues) => setCustomer(v), []);
  const [typedRows, setTypedRows] = useState<PassengerRow[] | null>(null);
  const onRows = useCallback((rows: PassengerRow[]) => setTypedRows(rows), []);
  const party = typedParty(customer);
  const [liveTotal, setLiveTotal] = useState<string | null>(vm.prices?.sellingTotalPaise ?? null);
  const [report, setReport] = useState<{ title: string; text: string | null; items: ErrorSummaryItem[]; key: number } | null>(null);
  const runs = useRef(0);
  const [busy, setBusy] = useState(false);
  const name = customer.contactName.trim() || view.contacts?.contactName || '';
  const status = useMemo(() => stepStatus(vm.sectionStatus), [vm.sectionStatus]);
  const countsUnsaved = String(vm.party.total ?? '') !== customer.paxTotal.trim() || String(vm.party.children ?? 0) !== (customer.children.trim() || '0') || String(vm.party.infants ?? 0) !== (customer.infants.trim() || '0');
  // Echo B-M2 (preview condition 29): a summary line about a field goes away once that field changes.
  useEffect(() => {
    if (!report) return;
    const onEdit = (e: Event) => {
      const id = (e.target as HTMLElement | null)?.id;
      if (!id) return;
      setReport((r) => {
        if (!r || !r.items.some((i) => i.fieldId === id)) return r;
        const items = r.items.filter((i) => i.fieldId !== id);
        return items.length === 0 ? null : { ...r, items };
      });
    };
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    return () => {
      document.removeEventListener('input', onEdit, true);
      document.removeEventListener('change', onEdit, true);
    };
  }, [report]);
  const show = (title: string, text: string | null, items: ErrorSummaryItem[]) => {
    runs.current += 1;
    setReport({ title, text, items, key: runs.current });
  };

  /** Saves every changed part in page order; stops at the first refusal (typed values stay). */
  const saveAll = async (): Promise<boolean> => {
    const pending = sync.dirtyEntries();
    const blocked = pending.filter((e) => !e.saveable);
    const label = (e: SyncedEntry) => e.label;
    const link = (e: SyncedEntry) => `#${e.targetId ?? e.section}`;
    if (blocked.length > 0) {
      const r = saveRunReport({ saved: [], refused: null, skipped: [], blocked: blocked.map(label) });
      show(saveRunSummaryTitle(r), saveReportText(r), blocked.map((e) => ({ kind: 'unsaved', partId: e.section as never, fieldId: e.targetId ?? null, message: SUMMARY_ITEM_TEXT.blocked(e.label), href: link(e) })));
      return false;
    }
    const saved: SyncedEntry[] = [];
    for (const [i, entry] of pending.entries()) {
      const result = await entry.submit({ refresh: false });
      if (!result.ok) {
        const skipped = pending.slice(i + 1);
        const r = saveRunReport({ saved: saved.map(label), refused: { label: entry.label, partId: entry.section as never, fieldId: entry.targetId ?? null, message: 'not saved (the reason is shown there)' }, skipped: skipped.map(label) });
        show(saveRunSummaryTitle(r), saveReportText(r), [
          { kind: 'refused', partId: entry.section as never, fieldId: entry.targetId ?? null, message: SUMMARY_ITEM_TEXT.refused(entry.label), href: link(entry) },
          ...skipped.map<ErrorSummaryItem>((e) => ({ kind: 'skipped', partId: e.section as never, fieldId: e.targetId ?? null, message: SUMMARY_ITEM_TEXT.skipped(e.label), href: link(e) })),
        ]);
        router.refresh();
        return false;
      }
      saved.push(entry);
    }
    if (saved.length > 0) router.refresh();
    return true;
  };

  const issuesFor = (s: FormStep): FormIssue[] => {
    // What is on screen (Echo B-L6): the refreshed view may not have arrived yet.
    const passengers = (typedRows ?? view.travellers.map((t) => ({ name: t.fullName, type: t.type }))).map((t) => ({ name: t.name ?? '', type: t.type }));
    const c = { contactName: customer.contactName, mobile: customer.mobile, email: customer.email, destination: customer.destination, tripStart: customer.start, tripEnd: customer.end, paxTotal: customer.paxTotal, children: customer.children, infants: customer.infants };
    const items = vm.items.map((i) => ({ id: i.itemId, serviceType: i.serviceType, facts: i.facts }));
    const scope: FormIssue[] = customer.scope ? [] : [{ code: 'trip_scope_missing', text: 'Choose domestic or international.', section: 'customer', fieldId: BOOKING_FORM_FIELD_ID.tripScope }];
    const split = countsProblem(customer, dealBacked(dealFacts).total);
    const counts: FormIssue[] = split ? [{ code: 'pax_split_invalid', text: split, section: 'customer', fieldId: BOOKING_FORM_FIELD_ID.adults }] : [];
    if (s === 'travellers') return [...customerIssues(c, passengers), ...scope, ...counts];
    if (s === 'stay') return [...customerIssues(c, passengers), ...scope, ...counts, ...serviceIssues({ start: customer.start || null, end: customer.end || null }, items)];
    return [];
  };

  const primary = async () => {
    if (busy) return;
    setBusy(true);
    setReport(null);
    try {
      if (editable && !(await saveAll())) return;
      if (step === 'finish') {
        const group = document.getElementById(BEFORE_SUBMIT_ID);
        if (group instanceof HTMLDetailsElement) group.open = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const trigger = document.getElementById(SUBMIT_TRIGGER_ID);
            if (trigger && trigger.getAttribute('aria-disabled') !== 'true') trigger.click();
            else focusField('review-heading');
          }),
        );
        return;
      }
      const found = issuesFor(step);
      if (found.length > 0) {
        show(
          'Check these details',
          null,
          found.map((x) => ({ kind: 'blocking', partId: x.section as never, fieldId: x.fieldId, message: x.text, href: `#${x.fieldId ?? `${x.section}-heading`}` })),
        );
        return;
      }
      go(step === 'travellers' ? 'stay' : 'finish');
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = FORM_STEPS.indexOf(step);
  const back = stepIndex > 0 ? FORM_STEPS[stepIndex - 1] : null;
  const primaryLabel = step === 'travellers' ? 'Save and go to step 2' : step === 'stay' ? 'Save and go to step 3' : 'Review and submit';
  const dirty = sync.dirtyEntries();
  const nights = tripNights(customer.start || null, customer.end || null);
  const counts = SERVICE_CHIPS.map((c) => ({ ...c, n: vm.items.filter((i) => i.serviceType === c.type).length })).filter((c) => c.n > 0);
  const countText = (type: string, label: string, n: number) => (n === 1 ? `1 ${SINGULAR[type] ?? label.toLowerCase()}` : `${n} ${label.toLowerCase()}`);
  const statusLine = [vm.statusLine.state, vm.statusLine.owner ?? (ownerText ? `Owner: ${ownerText}` : null)].filter(Boolean).join(' · ');

  const stepBox = (key: FormStep, children: ReactNode) => (
    <section key={key} data-form-step={key} aria-labelledby={stepHeadingId(key)} hidden={step !== key} className={cn('flex flex-col gap-4.5', step !== key && 'hidden')}>
      <h2 id={stepHeadingId(key)} tabIndex={-1} className="sr-only">
        Step {FORM_STEPS.indexOf(key) + 1} of 3: {BOOKING_FORM_STEP_LABEL[key]}
      </h2>
      {children}
    </section>
  );

  return (
    <div className="font-sans text-base text-copy">
      <p className="m-0 mb-3">
        <Link href={links.deal} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back to the deal
        </Link>
      </p>
      <div className="mb-5.5 flex flex-col gap-1">
        <h1 id="book-heading" tabIndex={-1} className="m-0 text-2xl leading-7.5 font-semibold tracking-[-0.02em] wrap-anywhere text-ink outline-none max-sm:text-xl">
          Book now{name ? ` · ${name}` : ''}
        </h1>
        <p className="m-0 text-sm text-quiet">
          <span className="sr-only">Status: </span>
          {view.dealReference} · {statusLine}
        </p>
        {vm.statusLine.next ? <p className="m-0 text-sm text-copy">{vm.statusLine.next}</p> : null}
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
      </div>

      <StepsBar status={status} />

      {report ? (
        <PageErrorSummary id="bf-report" summary={{ title: report.title, items: report.items }} focusKey={report.key} className="mb-4.5">
          {report.text ? <p className="m-0 mt-0.75">{report.text}</p> : null}
        </PageErrorSummary>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_14.75rem]">
        <div className="flex min-w-0 flex-col gap-4.5">
          {stepBox(
            'travellers',
            <>
              <CustomerTripCard vm={vm} view={view} reloadHref={reload} action={actions.saveCustomer} onValues={onCustomer} dealFacts={dealFacts} />
              <PassengersCard
                view={view}
                reloadHref={reload}
                counts={{ adults: effectiveAdults(customer), children: parseCount(customer.children || '0'), infants: parseCount(customer.infants || '0') }}
                onRows={onRows}
                actions={{ saveTravellers: actions.saveTravellers, saveIdentity: actions.saveIdentity, uploadIdProof: actions.uploadIdProof, removeIdProof: actions.removeIdProof, retryIdProofCopy: actions.retryIdProofCopy }}
              />
            </>,
          )}
          {stepBox(
            'stay',
            <ServicesStep vm={vm} view={view} actions={actions} reloadHref={reload} party={{ adults: party.adults, total: party.total }} tripStart={customer.start} tripEnd={customer.end} searchHotels={vn?.searchHotels ?? null} />,
          )}
          {stepBox(
            'finish',
            <>
              {vm.prices ? <PackagePriceCard prices={vm.prices} view={view} party={party} action={actions.savePrices} reloadHref={reload} onTotal={setLiveTotal} countsUnsaved={countsUnsaved} /> : <PriceLockedCard />}
              <BillToCard billTo={vm.billTo} view={view} action={actions.saveBillTo} reloadHref={reload} contact={{ name: customer.contactName, phone: customer.mobile, email: customer.email }} parties={vn?.parties ?? null} />
              <BeforeSubmit vm={vm} view={view} actions={actions} reloadHref={reload} />
            </>,
          )}
        </div>
        <aside aria-label="Booking summary" className="sticky top-5 hidden rounded-card border border-line bg-card p-4.5 xl:block">
          <h2 className="m-0 mb-4 text-base font-semibold text-ink">Booking summary</h2>
          <SummaryItem icon={MapPin} label="Destination" value={customer.destination || 'Not entered'} />
          <SummaryItem icon={CalendarDays} label="Travel date" value={customer.start ? `${dateText(customer.start)}${nights !== null ? ` · ${nights} nights` : ''}` : 'Not entered'} />
          <SummaryItem icon={Users} label="Passengers" value={customer.paxTotal || 'Not entered'} />
          {counts.map((c) => (
            <SummaryItem key={c.type} icon={SERVICE_ICON[c.type]} value={countText(c.type, c.label, c.n)} />
          ))}
          {step === 'finish' && vm.prices ? (
            <div className="mt-4 border-t border-line pt-3.5">
              <span className="text-sm text-quiet">Package selling total</span>
              <strong className="mt-[0.25rem] block text-xl font-semibold text-ink tabular-nums">{party.total ? formatInr(liveTotal, 'Not worked out yet') : 'Not worked out yet'}</strong>
            </div>
          ) : null}
        </aside>
      </div>

      <div
        data-slot="step-footer"
        className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-card px-1 py-3 max-sm:gap-x-2 [@media(min-height:36rem)]:sticky [@media(min-height:36rem)]:bottom-0 [@media(min-height:36rem)]:z-10"
      >
        <span className="text-sm text-quiet max-sm:text-xs" aria-live="polite">
          Step {stepIndex + 1} of 3
          <span className="max-sm:hidden">
            {' · '}
            {!editable ? 'View only' : dirty.length > 0 ? `Unsaved changes in: ${dirty.map((e) => e.label).join(', ')}` : 'All changes saved'}
          </span>
        </span>
        <div className="ml-auto flex items-center justify-end gap-2.5 max-sm:gap-2 max-[380px]:w-full">
          {back ? (
            <Button size="lg" className="min-h-11" onClick={() => go(back)}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
          ) : null}
          <Button variant="primary" size="lg" className="min-h-11 max-[380px]:h-auto max-[380px]:min-w-0 max-[380px]:flex-1 max-[380px]:py-2 max-[380px]:whitespace-normal" loading={busy} onClick={primary}>
            {busy ? 'Saving…' : primaryLabel}
            {step !== 'finish' && !busy ? <ArrowRight aria-hidden="true" /> : null}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SummaryItem({ icon: Icon, label, value }: { icon: typeof MapPin; label?: string; value: string }) {
  return (
    <div className="my-3.75 flex items-start gap-2.25 text-sm">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />
      <div className="min-w-0">
        {label ? <div className="text-quiet">{label}</div> : null}
        <div className="leading-5 font-medium wrap-anywhere text-ink">{value}</div>
      </div>
    </div>
  );
}
