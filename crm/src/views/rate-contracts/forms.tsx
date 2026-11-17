'use client';

import { Copy, Plus, Trash2, Upload } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskResultLine, refusalMessage, useDeskCommand, useRefusedControl, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { lineProblems, paiseToRupees, type LineDraft } from './format';
import { MEAL_PLAN_LABEL } from './labels';
import { MEAL_PLAN_CODES, type ContractSupplierChoice, type RateBlackoutView, type RateContractDetail, type RateLineView, type RoomTypeView } from './types';

/*
 * Rate contract client forms (Accounts phase 3 contract §9.3 E2–E5). Every
 * action arrives as a prop (the route passes track E's server action, the
 * preview gallery a stub), so these files never import server code. Field
 * names follow Phase 2 Addendum L3: rupee inputs end in `Rupees`, binding
 * values are hidden. One request id per form, renewed only after a confirmed
 * success; a refusal keeps every typed value, marks the field it names (a
 * rate line refusal names `lines[n].field`) and focuses it.
 */

const MAX_LINES = 500;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** Refusal summary + result line + request id: the top of every form here. */
function FormTop({ cmd, form, summaryId, okTitle, local }: { cmd: ReturnType<typeof useDeskCommand>; form: HTMLFormElement | null; summaryId: string; okTitle: string; local?: { id: string; text: string } | null }) {
  const refused = cmd.state && !cmd.state.ok ? cmd.state : null;
  const target = useRefusedControl(form, refused, summaryId);
  return (
    <>
      {local ? (
        <ErrorSummary title="Check the highlighted field" items={[{ fieldId: local.id, text: local.text }]} focusOnMount={false}>
          <p className="m-0 mt-[0.25rem] text-sm">Nothing was sent. What you typed is still here.</p>
        </ErrorSummary>
      ) : refused ? (
        <div id={summaryId}>
          <ErrorSummary title="Nothing was saved" description={refusalMessage(refused)} focusOnMount={!target} items={target ? [{ fieldId: target.id, text: `Check: ${target.label}` }] : []}>
            <p className="m-0 mt-[0.25rem] text-sm">What you typed is still here.</p>
          </ErrorSummary>
        </div>
      ) : cmd.state?.ok ? (
        <DeskResultLine state={cmd.state} okTitle={okTitle} />
      ) : (
        <div role="status" aria-live="polite" className="contents" />
      )}
      <input type="hidden" name="requestId" value={cmd.requestId} />
    </>
  );
}

function SubmitButton({ pending, label, pendingLabel, variant = 'primary' }: { pending: boolean; label: string; pendingLabel: string; variant?: 'primary' | 'secondary' }) {
  return (
    <Button
      type="submit"
      variant={variant}
      aria-disabled={pending || undefined}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}

/* ---------------------------------------------------------------- new contract */

/** E3 with no contract id: supplier, hotel and dates; the rate lines come next on the contract page. */
export function NewContractForm({ action, suppliers, initialState }: { action: DecisionAction; suppliers: ContractSupplierChoice[]; initialState?: DeskResult | null }) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.supplierId ?? '');
  const [local, setLocal] = useState<{ id: string; text: string } | null>(null);
  const hotels = suppliers.find((s) => s.supplierId === supplierId)?.hotels ?? [];
  const created = cmd.state?.ok ? ((cmd.state.data as { contractId?: string } | undefined)?.contractId ?? null) : null;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const fd = new FormData(e.currentTarget);
    const from = String(fd.get('validFrom') ?? '');
    const to = String(fd.get('validTo') ?? '');
    const problem = !fd.get('hotelId') ? { id: `${base}-hotelId`, text: 'Choose the hotel.' } : !from ? { id: `${base}-validFrom`, text: 'Enter the first date the rates apply.' } : !to ? { id: `${base}-validTo`, text: 'Enter the last date the rates apply.' } : from > to ? { id: `${base}-validTo`, text: 'The end date is before the start date.' } : null;
    setLocal(problem);
    if (problem) {
      e.preventDefault();
      document.getElementById(problem.id)?.focus();
      return;
    }
    cmd.submit(e);
  };
  return (
    <form ref={setForm} noValidate onSubmit={onSubmit} aria-label="Add a rate contract" className="flex flex-col gap-4">
      <FormTop cmd={cmd} form={form} summaryId={`${base}-summary`} okTitle="Draft contract made" local={local} />
      {created ? (
        <p className="m-0">
          <a href={`/app/purchase/rate-contracts/${created}`} className="font-semibold text-brand-strong underline underline-offset-4">
            Open the draft to add its rate lines
          </a>
        </p>
      ) : null}
      <input type="hidden" name="contractId" value="" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field htmlFor={`${base}-supplierId`} label="Supplier" hint="Only suppliers that sell hotels are listed.">
          <Select id={`${base}-supplierId`} name="supplierId" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-describedby={`${base}-supplierId-hint`}>
            {suppliers.map((s) => (
              <option key={s.supplierId} value={s.supplierId}>
                {s.supplierName}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${base}-hotelId`} label="Hotel" hint={hotels.length === 0 ? 'This supplier has no linked hotel. Link a hotel on the supplier page first.' : 'Hotels linked to this supplier.'}>
          <Select id={`${base}-hotelId`} name="hotelId" key={supplierId} defaultValue={hotels[0]?.hotelId ?? ''} aria-describedby={`${base}-hotelId-hint`}>
            {hotels.length === 0 ? <option value="">No linked hotel</option> : null}
            {hotels.map((h) => (
              <option key={h.hotelId} value={h.hotelId}>
                {h.name}
                {h.city ? `, ${h.city}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${base}-validFrom`} label="Rates apply from">
          <Input id={`${base}-validFrom`} name="validFrom" type="date" />
        </Field>
        <Field htmlFor={`${base}-validTo`} label="Rates apply until" hint="At most about three years after the start.">
          <Input id={`${base}-validTo`} name="validTo" type="date" aria-describedby={`${base}-validTo-hint`} />
        </Field>
      </div>
      <div>
        <SubmitButton pending={cmd.pending} label="Make draft contract" pendingLabel="Making the draft…" variant="secondary" />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- contract details */

/** E3 on a draft or returned contract: dates, cancellation terms and a note. */
export function ContractDetailsForm({ action, contract, initialState }: { action: DecisionAction; contract: RateContractDetail; initialState?: DeskResult | null }) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [local, setLocal] = useState<{ id: string; text: string } | null>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const fd = new FormData(e.currentTarget);
    const from = String(fd.get('validFrom') ?? '');
    const to = String(fd.get('validTo') ?? '');
    const problem = !from ? { id: `${base}-validFrom`, text: 'Enter the first date the rates apply.' } : !to ? { id: `${base}-validTo`, text: 'Enter the last date the rates apply.' } : from > to ? { id: `${base}-validTo`, text: 'The end date is before the start date.' } : null;
    setLocal(problem);
    if (problem) {
      e.preventDefault();
      document.getElementById(problem.id)?.focus();
      return;
    }
    cmd.submit(e);
  };
  return (
    <form ref={setForm} noValidate onSubmit={onSubmit} aria-label="Contract details" className="flex flex-col gap-4">
      <FormTop cmd={cmd} form={form} summaryId={`${base}-summary`} okTitle="Saved" local={local} />
      <input type="hidden" name="contractId" value={contract.contractId} />
      <input type="hidden" name="expectedRowVersion" value={contract.rowVersion} />
      <input type="hidden" name="supplierId" value={contract.supplierId} />
      <input type="hidden" name="hotelId" value={contract.hotelId} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field htmlFor={`${base}-validFrom`} label="Rates apply from">
          <Input id={`${base}-validFrom`} name="validFrom" type="date" defaultValue={contract.validFrom} />
        </Field>
        <Field htmlFor={`${base}-validTo`} label="Rates apply until">
          <Input id={`${base}-validTo`} name="validTo" type="date" defaultValue={contract.validTo} />
        </Field>
      </div>
      <Field htmlFor={`${base}-cancellationTerms`} label="Cancellation terms" optional hint="As the supplier wrote them. Up to 2,000 characters.">
        <Textarea id={`${base}-cancellationTerms`} name="cancellationTerms" maxLength={2000} rows={3} defaultValue={contract.cancellationTerms ?? ''} aria-describedby={`${base}-cancellationTerms-hint`} />
      </Field>
      <Field htmlFor={`${base}-note`} label="Note for the team" optional>
        <Textarea id={`${base}-note`} name="note" maxLength={500} rows={2} defaultValue={contract.note ?? ''} />
      </Field>
      <div>
        <SubmitButton pending={cmd.pending} label="Save details" pendingLabel="Saving…" variant="secondary" />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ rate lines */

const blankLine = (from: string, to: string): LineDraft => ({
  seasonFrom: from,
  seasonTo: to,
  roomTypeId: '',
  mealPlan: '',
  rateRupees: '',
  weekendRateRupees: '',
  extraAdultRupees: '',
  childWithBedRupees: '',
  childWithoutBedRupees: '',
  note: '',
});

function toDraft(l: RateLineView): LineDraft {
  return {
    seasonFrom: l.seasonFrom,
    seasonTo: l.seasonTo,
    roomTypeId: l.roomTypeId,
    mealPlan: l.mealPlan,
    rateRupees: paiseToRupees(l.ratePaise),
    weekendRateRupees: paiseToRupees(l.weekendRatePaise),
    extraAdultRupees: paiseToRupees(l.extraAdultPaise),
    childWithBedRupees: paiseToRupees(l.childWithBedPaise),
    childWithoutBedRupees: paiseToRupees(l.childWithoutBedPaise),
    note: l.note ?? '',
  };
}

type Keyed<T> = T & { key: number };

/**
 * E4: every rate line and blackout of a draft or returned contract, saved
 * together (the command replaces them all). Each line is a small card of
 * fields, so the grid reads the same at 1280 px and at 375 px without
 * sideways scrolling.
 */
export function RateLinesForm({ action, contract, roomTypes, initialState }: { action: DecisionAction; contract: RateContractDetail; roomTypes: RoomTypeView[]; initialState?: DeskResult | null }) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [seq, setSeq] = useState(1000);
  const [lines, setLines] = useState<Array<Keyed<LineDraft>>>(() =>
    contract.lines.length > 0 ? contract.lines.map((l, i) => ({ ...toDraft(l), key: i })) : [{ ...blankLine(contract.validFrom, contract.validTo), key: 0 }],
  );
  const [blackouts, setBlackouts] = useState<Array<Keyed<RateBlackoutView>>>(() => contract.blackouts.map((b, i) => ({ ...b, key: i })));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState('');
  const next = () => {
    setSeq((s) => s + 1);
    return seq;
  };
  const setLine = (i: number, k: keyof LineDraft, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const err = (i: number, f: string) => problems[`lines[${i}].${f}`] ?? null;
  const id = (group: string, i: number, f: string) => `${base}-${group}-${i}-${f}`;
  const firstProblem = Object.keys(problems)[0];
  const fm = firstProblem ? /^(lines|blackouts)\[(\d+)\]\.(\w+)$/.exec(firstProblem) : null;
  const localSummary = fm ? { id: id(fm[1]!, Number(fm[2]), fm[3]!), text: `${fm[1] === 'lines' ? 'Line' : 'Blackout'} ${Number(fm[2]) + 1}: ${problems[firstProblem!]}` } : null;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const p = lineProblems(lines, { from: contract.validFrom, to: contract.validTo });
    blackouts.forEach((b, i) => {
      if (!b.fromDate || !b.toDate) p[`blackouts[${i}].fromDate`] = 'Enter both blackout dates, or remove the blackout.';
      else if (b.fromDate > b.toDate) p[`blackouts[${i}].toDate`] = 'The blackout ends before it starts.';
    });
    setProblems(p);
    const first = Object.keys(p)[0];
    if (first) {
      e.preventDefault();
      const m = /^(lines|blackouts)\[(\d+)\]\.(\w+)$/.exec(first);
      if (m) document.getElementById(id(m[1]!, Number(m[2]), m[3]!))?.focus();
      return;
    }
    cmd.submit(e);
  };

  const moneyField = (i: number, f: 'rateRupees' | 'weekendRateRupees' | 'extraAdultRupees' | 'childWithBedRupees' | 'childWithoutBedRupees', label: string, opts: { optional?: boolean; hint?: string }) => (
    <Field
      htmlFor={id('lines', i, f)}
      label={
        <>
          <span className="sr-only">Line {i + 1}: </span>
          {label}
        </>
      }
      optional={opts.optional}
      hint={opts.hint}
      error={err(i, f)}
    >
      <MoneyInput
        id={id('lines', i, f)}
        name={`lines[${i}].${f}`}
        value={lines[i]![f]}
        onChange={(e) => setLine(i, f, e.target.value)}
        maxLength={16}
        invalid={!!err(i, f)}
        aria-describedby={fieldDescribedBy(id('lines', i, f), { hint: opts.hint, error: err(i, f) })}
      />
    </Field>
  );

  return (
    <form ref={setForm} noValidate onSubmit={onSubmit} aria-label="Rate lines and blackout dates" className="flex flex-col gap-4">
      <FormTop
        cmd={cmd}
        form={form}
        summaryId={`${base}-summary`}
        okTitle="Rate lines saved"
        local={localSummary}
      />
      <input type="hidden" name="contractId" value={contract.contractId} />
      <input type="hidden" name="expectedRowVersion" value={contract.rowVersion} />
      <input type="hidden" name="lineCount" value={lines.length} />
      <input type="hidden" name="blackoutCount" value={blackouts.length} />
      <p className="m-0 text-sm text-quiet">
        Rates are per room per night, from {contract.validFrom} to {contract.validTo}. Weekend rate is for Friday and Saturday nights. Leave a child or extra adult rate empty when it is not offered.
      </p>
      {roomTypes.length === 0 ? (
        <Notice tone="warning" title="This hotel has no room types yet">
          <p>Add the hotel’s room types below the rate lines first, then choose them here.</p>
        </Notice>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Rate lines">
        {lines.map((l, i) => (
          <li key={l.key} className="m-0">
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-control border border-line bg-card p-3.5">
              <legend className="px-1 text-base font-semibold text-ink">Line {i + 1}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field htmlFor={id('lines', i, 'seasonFrom')} label={<><span className="sr-only">Line {i + 1}: </span>Season from</>} error={err(i, 'seasonFrom')}>
                  <Input id={id('lines', i, 'seasonFrom')} name={`lines[${i}].seasonFrom`} type="date" min={contract.validFrom} max={contract.validTo} value={l.seasonFrom} onChange={(e) => setLine(i, 'seasonFrom', e.target.value)} invalid={!!err(i, 'seasonFrom')} aria-describedby={fieldDescribedBy(id('lines', i, 'seasonFrom'), { error: err(i, 'seasonFrom') })} />
                </Field>
                <Field htmlFor={id('lines', i, 'seasonTo')} label={<><span className="sr-only">Line {i + 1}: </span>Season to</>} error={err(i, 'seasonTo')}>
                  <Input id={id('lines', i, 'seasonTo')} name={`lines[${i}].seasonTo`} type="date" min={contract.validFrom} max={contract.validTo} value={l.seasonTo} onChange={(e) => setLine(i, 'seasonTo', e.target.value)} invalid={!!err(i, 'seasonTo')} aria-describedby={fieldDescribedBy(id('lines', i, 'seasonTo'), { error: err(i, 'seasonTo') })} />
                </Field>
                <Field htmlFor={id('lines', i, 'roomTypeId')} label={<><span className="sr-only">Line {i + 1}: </span>Room type</>} error={err(i, 'roomTypeId')}>
                  <Select id={id('lines', i, 'roomTypeId')} name={`lines[${i}].roomTypeId`} value={l.roomTypeId} onChange={(e) => setLine(i, 'roomTypeId', e.target.value)} invalid={!!err(i, 'roomTypeId')} aria-describedby={fieldDescribedBy(id('lines', i, 'roomTypeId'), { error: err(i, 'roomTypeId') })}>
                    <option value="">Choose…</option>
                    {roomTypes.map((r) => (
                      <option key={r.roomTypeId} value={r.roomTypeId}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field htmlFor={id('lines', i, 'mealPlan')} label={<><span className="sr-only">Line {i + 1}: </span>Meal plan</>} error={err(i, 'mealPlan')}>
                  <Select id={id('lines', i, 'mealPlan')} name={`lines[${i}].mealPlan`} value={l.mealPlan} onChange={(e) => setLine(i, 'mealPlan', e.target.value)} invalid={!!err(i, 'mealPlan')} aria-describedby={fieldDescribedBy(id('lines', i, 'mealPlan'), { error: err(i, 'mealPlan') })}>
                    <option value="">Choose…</option>
                    {MEAL_PLAN_CODES.map((c) => (
                      <option key={c} value={c}>
                        {MEAL_PLAN_LABEL[c]} ({c})
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {moneyField(i, 'rateRupees', 'Rate per night', {})}
                {moneyField(i, 'weekendRateRupees', 'Weekend rate', { optional: true })}
                {moneyField(i, 'extraAdultRupees', 'Extra adult', { optional: true })}
                {moneyField(i, 'childWithBedRupees', 'Child with bed', { optional: true })}
                {moneyField(i, 'childWithoutBedRupees', 'Child without bed', { optional: true })}
              </div>
              <Field htmlFor={id('lines', i, 'note')} label={<><span className="sr-only">Line {i + 1}: </span>Note</>} optional>
                <Input id={id('lines', i, 'note')} name={`lines[${i}].note`} maxLength={300} value={l.note} onChange={(e) => setLine(i, 'note', e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-disabled={lines.length >= MAX_LINES || undefined}
                  onClick={() => {
                    if (lines.length >= MAX_LINES) return;
                    const k = next();
                    setLines((ls) => [...ls.slice(0, i + 1), { ...ls[i]!, key: k }, ...ls.slice(i + 1)]);
                    setProblems({});
                    setAnnounce(`Line ${i + 1} copied as line ${i + 2}.`);
                  }}
                >
                  <Copy aria-hidden="true" />
                  Copy line {i + 1}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-disabled={lines.length === 1 || undefined}
                  aria-describedby={lines.length === 1 ? `${base}-one-line` : undefined}
                  onClick={() => {
                    if (lines.length === 1) return;
                    setLines((ls) => ls.filter((_, j) => j !== i));
                    setProblems({});
                    setAnnounce(`Line ${i + 1} removed. Not saved yet.`);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove line {i + 1}
                </Button>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <p id={`${base}-one-line`} className="sr-only">
        A contract needs at least one line.
      </p>
      <div>
        <Button
          type="button"
          variant="secondary"
          aria-disabled={lines.length >= MAX_LINES || undefined}
          onClick={() => {
            if (lines.length >= MAX_LINES) return;
            const k = next();
            setLines((ls) => [...ls, { ...blankLine(contract.validFrom, contract.validTo), key: k }]);
            setAnnounce(`Line ${lines.length + 1} added.`);
            requestAnimationFrame(() => document.getElementById(id('lines', lines.length, 'seasonFrom'))?.focus());
          }}
        >
          <Plus aria-hidden="true" />
          Add a rate line
        </Button>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 p-0 text-base font-semibold text-ink">Blackout dates</legend>
        <p className="m-0 text-sm text-quiet">Nights the contract rate does not apply. Offers for these nights say “blackout” instead of a rate.</p>
        {blackouts.length === 0 ? <p className="m-0 text-sm text-copy">No blackout dates.</p> : null}
        <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Blackout dates">
          {blackouts.map((b, i) => {
            const fe = problems[`blackouts[${i}].fromDate`] ?? null;
            const te = problems[`blackouts[${i}].toDate`] ?? null;
            return (
              <li key={b.key} className="m-0 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
                <Field htmlFor={id('blackouts', i, 'fromDate')} label={<><span className="sr-only">Blackout {i + 1}: </span>From</>} error={fe}>
                  <Input id={id('blackouts', i, 'fromDate')} name={`blackouts[${i}].fromDate`} type="date" value={b.fromDate} onChange={(e) => setBlackouts((bs) => bs.map((x, j) => (j === i ? { ...x, fromDate: e.target.value } : x)))} invalid={!!fe} aria-describedby={fieldDescribedBy(id('blackouts', i, 'fromDate'), { error: fe })} />
                </Field>
                <Field htmlFor={id('blackouts', i, 'toDate')} label={<><span className="sr-only">Blackout {i + 1}: </span>To</>} error={te}>
                  <Input id={id('blackouts', i, 'toDate')} name={`blackouts[${i}].toDate`} type="date" value={b.toDate} onChange={(e) => setBlackouts((bs) => bs.map((x, j) => (j === i ? { ...x, toDate: e.target.value } : x)))} invalid={!!te} aria-describedby={fieldDescribedBy(id('blackouts', i, 'toDate'), { error: te })} />
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mb-1 w-fit"
                  onClick={() => {
                    setBlackouts((bs) => bs.filter((_, j) => j !== i));
                    setProblems({});
                    setAnnounce(`Blackout ${i + 1} removed. Not saved yet.`);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove blackout {i + 1}
                </Button>
              </li>
            );
          })}
        </ol>
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              const k = next();
              setBlackouts((bs) => [...bs, { fromDate: '', toDate: '', key: k }]);
              setAnnounce(`Blackout ${blackouts.length + 1} added.`);
              requestAnimationFrame(() => document.getElementById(id('blackouts', blackouts.length, 'fromDate'))?.focus());
            }}
          >
            <Plus aria-hidden="true" />
            Add blackout dates
          </Button>
        </div>
      </fieldset>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <SubmitButton pending={cmd.pending} label={`Save ${lines.length} rate ${lines.length === 1 ? 'line' : 'lines'}`} pendingLabel="Saving…" variant="secondary" />
        <span className="text-sm text-quiet">Saving replaces every line and blackout of this draft.</span>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ room types */

/** E2: add a room type to the hotel (rename and remove live in the list beside it). */
export function RoomTypeAddForm({ action, hotelId, initialState }: { action: DecisionAction; hotelId: string; initialState?: DeskResult | null }) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [name, setName] = useState('');
  const [local, setLocal] = useState<{ id: string; text: string } | null>(null);
  const [seen, setSeen] = useState(cmd.state);
  if (cmd.state !== seen) {
    setSeen(cmd.state);
    if (cmd.state?.ok) setName('');
  }
  return (
    <form
      ref={setForm}
      noValidate
      onSubmit={(e) => {
        const problem = name.trim() ? null : { id: `${base}-name`, text: 'Enter the room type name, like Deluxe room.' };
        setLocal(problem);
        if (problem) {
          e.preventDefault();
          document.getElementById(problem.id)?.focus();
          return;
        }
        cmd.submit(e);
      }}
      aria-label="Add a room type"
      className="flex flex-col gap-3"
    >
      <FormTop cmd={cmd} form={form} summaryId={`${base}-summary`} okTitle="Room type added" local={local} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="roomTypeId" value="" />
      <input type="hidden" name="expectedRowVersion" value="" />
      <div className="flex flex-wrap items-end gap-2">
        <Field htmlFor={`${base}-name`} label="New room type" className="min-w-0 flex-1 basis-56">
          <Input id={`${base}-name`} name="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <SubmitButton pending={cmd.pending} label="Add room type" pendingLabel="Adding…" variant="secondary" />
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------------- files */

/** E5: upload the supplier's signed contract or rate sheet (PDF or picture, up to 4 MB). */
export function ContractFileForm({ action, contractId, initialState }: { action: DecisionAction; contractId: string; initialState?: DeskResult | null }) {
  const base = useId();
  const cmd = useDeskCommand(action, initialState ?? null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [local, setLocal] = useState<{ id: string; text: string } | null>(null);
  return (
    <form
      ref={setForm}
      noValidate
      onSubmit={(e) => {
        const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
        const problem = !file
          ? { id: `${base}-file`, text: 'Choose the file first.' }
          : !FILE_TYPES.includes(file.type)
            ? { id: `${base}-file`, text: 'Use a PDF, JPEG, PNG or WebP file.' }
            : file.size > FILE_MAX_BYTES
              ? { id: `${base}-file`, text: 'The file is larger than 4 MB. Make it smaller and try again.' }
              : null;
        setLocal(problem);
        if (problem) {
          e.preventDefault();
          document.getElementById(problem.id)?.focus();
          return;
        }
        cmd.submit(e);
      }}
      aria-label="Upload a contract file"
      className="flex flex-col gap-3"
    >
      <FormTop cmd={cmd} form={form} summaryId={`${base}-summary`} okTitle="File uploaded" local={local} />
      <input type="hidden" name="contractId" value={contractId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field htmlFor={`${base}-file`} label="Contract file" hint="PDF, JPEG, PNG or WebP, up to 4 MB." className="min-w-0 flex-1 basis-64">
          <Input id={`${base}-file`} name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" aria-describedby={`${base}-file-hint`} />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          aria-disabled={cmd.pending || undefined}
          onClick={(e) => {
            if (cmd.pending) e.preventDefault();
          }}
        >
          <Upload aria-hidden="true" />
          {cmd.pending ? 'Uploading…' : 'Upload file'}
        </Button>
      </div>
    </form>
  );
}

/** Small wrapper so a Server Component can show a form section heading with its form. */
export function FormSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="m-0 text-base font-semibold text-ink">
        {title}
      </h3>
      {description ? <div className="m-0 text-sm text-quiet">{description}</div> : null}
      {children}
    </section>
  );
}
