'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/choice';
import { Field, FieldError, fieldDescribedBy } from '@/components/ui/field';
import { Fieldset } from '@/components/ui/fieldset';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Select } from '@/components/ui/select';
import type { ErrorSummaryItem } from '@/components/ui/error-summary';
import { guard } from '@/views/accounts/supplier-forms';
import { formOf, VF } from './actions';
import { dayText, fileProblem, rupeesToPaise, todayIst, whenText } from './format';
import { CheckSummary, FileField, PopupFacts, RefusalSummary, refusedFields, useCommand, useIds, VisaPopup, type VisaResult } from './kit';
import { visaApplicantField } from '@/modules/visa/contracts';
import { defaultPaidBy, KIND_LABEL, nameOf, PAID_BY_LABEL, PAYMENT_MODE_LABEL, PAYMENT_MODES, plural } from './labels';
import type { WorkCtx } from './passengers';
import type { VisaApplicant, VisaPaidBy } from './types';
import { defaultAppliedOn, isPassportTask, salesJurisdictionBlank, salesVisa, type PopupSeed } from './work-model';

/*
 * Mark as applied (HTML applyDrawer H:15140) and Confirm applied for several
 * passengers together (bulkDrawer H:15167): one visa_applications_apply call
 * for 1..n passengers. Per passenger: reference, applied date (the
 * appointment date when not after today, else today), government fee and
 * optional service fee — the first passenger's fees fill the empty boxes
 * below and are never split. Shared: kind / jurisdiction when Sales left them
 * blank, passport taken (sticker), who paid and how, one fee receipt for
 * all, remark. A fee receipt chosen here is uploaded once, then kept for a
 * retry. Any refusal saves nothing; every typed value stays.
 */

interface Line {
  reference: string;
  appliedOn: string;
  gov: string;
  svc: string;
}

/** Server hint index → line index. Hints are 0-based positions in the posted applicants (lead decision); out-of-range ones are ignored. */
function hintLine(hints: Set<string>, n: number): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const parsed = [...hints].map((h) => /^applicants\[(\d+)\](?:\.(\w+)|:(\w+))?$/.exec(h)).filter((m): m is RegExpExecArray => !!m);
  for (const m of parsed) {
    const i = Number(m[1]);
    if (i >= n) continue;
    const set = out.get(i) ?? new Set<string>();
    set.add(m[2] ?? m[3] ?? 'line');
    out.set(i, set);
  }
  return out;
}

export function ApplyPopup({ ctx, list, open, onOpenChange, returnFocusId, seed }: { ctx: WorkCtx; list: VisaApplicant[]; open: boolean; onOpenChange: (o: boolean) => void; returnFocusId?: string; seed?: PopupSeed }) {
  const { ws, actions } = ctx;
  const ids = useIds('apply');
  const today = todayIst();
  const many = list.length > 1;
  const sv = salesVisa(ws);
  const passport = isPassportTask(ws);
  const needKind = !passport && list.some((a) => !a.visaKind.value);
  const [lines, setLines] = useState<Record<string, Line>>(() => Object.fromEntries(list.map((a) => [a.applicationId, { reference: seed?.references?.[list.indexOf(a)] ?? '', appliedOn: defaultAppliedOn(a, today), gov: seed?.governmentFees?.[list.indexOf(a)] ?? '', svc: '' }])));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState('');
  const [jur, setJur] = useState('');
  const [place, setPlace] = useState('');
  const [taken, setTaken] = useState(false);
  const [paidBy, setPaidBy] = useState<VisaPaidBy>(defaultPaidBy(ws));
  const [mode, setMode] = useState(seed?.paymentMode ?? '');
  const [remark, setRemark] = useState(seed?.remark ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [receipt, setReceipt] = useState<{ evidenceId: string; fileName: string } | null>(null);
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const [lineErr, setLineErr] = useState<Record<string, Record<string, string>>>({});
  const cmd = useCommand(actions.apply, seed?.result ?? null);

  const kinds = list.map((a) => a.visaKind.value ?? (needKind ? (kind as 'e_visa' | 'sticker' | '') || null : null));
  const allSticker = !passport && kinds.every((k) => k === 'sticker');
  const showJur = !passport && salesJurisdictionBlank(ws) && allSticker && list.some((a) => a.jurisdiction.required === null);
  const server = refusedFields(cmd.state);
  const byLine = hintLine(server, list.length);

  const setLine = (a: VisaApplicant, key: keyof Line, value: string) => {
    setLines((all) => {
      const next = { ...all, [a.applicationId]: { ...all[a.applicationId]!, [key]: value } };
      // The first passenger's fees fill the boxes below that nobody typed in (never split).
      if (a.applicationId === list[0]!.applicationId && (key === 'gov' || key === 'svc')) {
        for (const b of list.slice(1)) if (!touched.has(`${b.applicationId}:${key}`)) next[b.applicationId] = { ...next[b.applicationId]!, [key]: value };
      }
      return next;
    });
    if (a.applicationId !== list[0]!.applicationId) setTouched((t) => new Set(t).add(`${a.applicationId}:${key}`));
  };

  const fid = (a: VisaApplicant, k: string) => ids(`${k}-${a.seq}`);

  const submit = () => {
    const items: ErrorSummaryItem[] = [];
    const le: Record<string, Record<string, string>> = {};
    const refs = new Map<string, string>();
    const add = (a: VisaApplicant | null, key: string, field: string, text: string) => {
      if (a) le[a.applicationId] = { ...(le[a.applicationId] ?? {}), [key]: text };
      items.push({ fieldId: field, text: a && many ? `${nameOf(a)}: ${text}` : text });
    };
    for (const a of list) {
      const l = lines[a.applicationId]!;
      const ref = l.reference.trim();
      if (!ref) add(a, 'reference', fid(a, 'ref'), 'Type the reference number.');
      else if (ref.length > 120) add(a, 'reference', fid(a, 'ref'), 'Use at most 120 characters.');
      else if (refs.has(ref.toLowerCase())) add(a, 'reference', fid(a, 'ref'), 'Each passenger needs their own reference.');
      refs.set(ref.toLowerCase(), a.applicationId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.appliedOn)) add(a, 'appliedOn', fid(a, 'on'), 'Set the applied date.');
      else if (l.appliedOn > today) add(a, 'appliedOn', fid(a, 'on'), 'The applied date cannot be after today.');
      if (!rupeesToPaise(l.gov)) add(a, 'governmentFee', fid(a, 'gov'), 'Type the government fee in rupees, more than ₹0.');
      if (l.svc.trim() && !rupeesToPaise(l.svc)) add(a, 'serviceFee', fid(a, 'svc'), 'Type the service fee in rupees, or leave it empty.');
    }
    if (needKind && !kind) add(null, 'visaKind', ids('kind'), 'Choose E-visa or Sticker visa.');
    if (showJur && jur === 'yes' && !place.trim()) add(null, 'jurisdictionPlace', ids('place'), 'Add the jurisdiction place.');
    if (paidBy === 'company' && !mode) add(null, 'paymentMode', ids('mode'), 'Choose how the fee was paid.');
    const fp = receipt ? null : fileProblem(file, false);
    if (fp) add(null, 'file', ids('file'), fp);
    if (remark.trim().length > 300) add(null, 'remark', ids('remark'), 'Use at most 300 characters.');
    setLineErr(le);
    setProblems(items);
    if (items.length) return;

    cmd.send(async (rid) => {
      let receiptId = receipt?.evidenceId ?? null;
      if (!receiptId && file) {
        const fd = formOf({ [VF.taskId]: ws.taskId, [VF.dealId]: ws.dealId, [VF.applicationId]: many ? null : list[0]!.applicationId, [VF.kind]: 'fee_receipt', [VF.file]: file });
        const r = (await guard(actions.uploadEvidence)(null, fd)) as VisaResult;
        if (!r.ok) {
          cmd.setState(r);
          return null;
        }
        const data = (r.data ?? {}) as { evidenceId?: string; fileName?: string };
        if (!data.evidenceId) return null;
        receiptId = data.evidenceId;
        setReceipt({ evidenceId: data.evidenceId, fileName: data.fileName ?? file.name });
      }
      const f: Record<string, string | boolean | null> = {
        [VF.taskId]: ws.taskId,
        [VF.dealId]: ws.dealId,
        [VF.applicantCount]: String(list.length),
        [VF.paidBy]: paidBy,
        [VF.paymentMode]: paidBy === 'company' ? mode : null,
        [VF.receiptEvidenceId]: receiptId,
        [VF.remark]: remark.trim(),
      };
      list.forEach((a, i) => {
        const l = lines[a.applicationId]!;
        f[visaApplicantField(i, 'applicationId')] = a.applicationId;
        f[visaApplicantField(i, 'expectedRowVersion')] = String(a.rowVersion);
        f[visaApplicantField(i, 'reference')] = l.reference.trim();
        f[visaApplicantField(i, 'appliedOn')] = l.appliedOn;
        f[visaApplicantField(i, 'governmentFee')] = l.gov.trim();
        f[visaApplicantField(i, 'serviceFee')] = l.svc.trim();
      });
      if (needKind) f[VF.visaKind] = kind;
      if (showJur && jur) {
        f[VF.jurisdiction] = jur;
        f[VF.jurisdictionPlace] = jur === 'yes' ? place.trim() : '';
      }
      if (allSticker && taken) f[VF.passportTaken] = true;
      return formOf(f, rid);
    });
  };

  const e = (a: VisaApplicant, key: string, fallback: string) => lineErr[a.applicationId]?.[key] ?? (byLine.get(list.indexOf(a))?.has(key) ? fallback : null);
  const salesFacts: Array<[string, string]> = [];
  if (sv?.visaKind) salesFacts.push(['Visa type', `${KIND_LABEL[sv.visaKind]} · from Sales`]);
  if (sv?.jurisdiction && sv.visaKind !== 'e_visa') salesFacts.push(['Jurisdiction', `${sv.jurisdiction === 'yes' ? `Yes, ${sv.jurisdictionPlace ?? ''}` : 'No'} · from Sales`]);
  const lineProblems = [...byLine.entries()].filter(([, keys]) => [...keys].some((k) => !['reference', 'appliedOn', 'governmentFee', 'serviceFee'].includes(k)));

  return (
    <VisaPopup
      open={open}
      onOpenChange={onOpenChange}
      title={many ? 'Confirm applied' : 'Mark as applied'}
      description={many ? `${plural(list.length, 'passenger')} applied together` : nameOf(list[0]!)}
      formId={ids('form')}
      primaryLabel={many ? 'Confirm applied' : 'Save as applied'}
      pending={cmd.pending}
      wide={many}
      onSubmit={submit}
      returnFocusId={returnFocusId}
      result={cmd.state}
      onDone={ctx.done}
    >
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!file} />
      {lineProblems.length ? (
        <ul className="m-0 list-disc pl-5 text-sm text-status-danger">
          {lineProblems.map(([i]) => (list[i] ? <li key={i}>{nameOf(list[i]!)} is not ready to apply. Close this popup and check the passenger.</li> : null))}
        </ul>
      ) : null}
      {!many ? (
        <PopupFacts
          rows={[
            ['Passenger', nameOf(list[0]!)],
            ...(list[0]!.passport ? [['Passport', list[0]!.passport.number ?? 'Not recorded'] as [string, string]] : []),
            ['Appointment', whenText(list[0]!.appointment.date, list[0]!.appointment.time)],
            ...salesFacts,
          ]}
        />
      ) : salesFacts.length ? (
        <PopupFacts rows={salesFacts} />
      ) : null}
      {!many ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor={fid(list[0]!, 'ref')} label="Reference number" error={e(list[0]!, 'reference', 'Check the reference number.')}>
            <Input
              id={fid(list[0]!, 'ref')}
              value={lines[list[0]!.applicationId]!.reference}
              maxLength={120}
              autoComplete="off"
              invalid={!!e(list[0]!, 'reference', 'x')}
              aria-describedby={fieldDescribedBy(fid(list[0]!, 'ref'), { error: e(list[0]!, 'reference', 'x') })}
              onChange={(ev) => setLine(list[0]!, 'reference', ev.currentTarget.value)}
            />
          </Field>
          <Field htmlFor={fid(list[0]!, 'on')} label="Applied date" hint="Filled from the appointment date. Change it if needed." error={e(list[0]!, 'appliedOn', 'Check the applied date.')}>
            <Input
              id={fid(list[0]!, 'on')}
              type="date"
              max={today}
              value={lines[list[0]!.applicationId]!.appliedOn}
              invalid={!!e(list[0]!, 'appliedOn', 'x')}
              aria-describedby={fieldDescribedBy(fid(list[0]!, 'on'), { hint: true, error: e(list[0]!, 'appliedOn', 'x') })}
              onChange={(ev) => setLine(list[0]!, 'appliedOn', ev.currentTarget.value)}
            />
          </Field>
        </div>
      ) : null}
      {needKind || showJur || allSticker ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {needKind ? (
            <Field htmlFor={ids('kind')} label="Visa type" hint="Sales did not set this on the booking." error={problems.some((p) => p.fieldId === ids('kind')) || server.has(VF.visaKind) ? 'Choose E-visa or Sticker visa.' : null}>
              <Select id={ids('kind')} value={kind} invalid={server.has(VF.visaKind)} aria-describedby={fieldDescribedBy(ids('kind'), { hint: true })} onChange={(ev) => setKind(ev.currentTarget.value)}>
                <option value="">Choose</option>
                <option value="e_visa">{KIND_LABEL.e_visa}</option>
                <option value="sticker">{KIND_LABEL.sticker}</option>
              </Select>
            </Field>
          ) : null}
          {kinds.every((k) => k === 'e_visa') && !passport ? <p className="m-0 text-sm text-quiet sm:col-span-2">E-visa: the passport is not collected. Only a photo of the passport is needed.</p> : null}
          {allSticker ? (
            <div className="sm:col-span-2">
              <Checkbox id={ids('taken')} label={many ? 'Passports taken from the customers' : 'Passport taken from the customer'} description="Tick it when the passport is now with us." checked={taken} onChange={(ev) => setTaken(ev.currentTarget.checked)} />
            </div>
          ) : null}
          {showJur ? (
            <>
              <Field htmlFor={ids('jur')} label="Jurisdiction passport?" hint="Sales did not set this on the booking." optional>
                <Select id={ids('jur')} value={jur} aria-describedby={fieldDescribedBy(ids('jur'), { hint: true })} onChange={(ev) => setJur(ev.currentTarget.value)}>
                  <option value="">Not decided yet</option>
                  <option value="no">No, it can be sent from here</option>
                  <option value="yes">Yes, it must go to a set place</option>
                </Select>
              </Field>
              {jur === 'yes' ? (
                <Field htmlFor={ids('place')} label="Where the passport must be sent" error={problems.some((p) => p.fieldId === ids('place')) || server.has(VF.jurisdictionPlace) ? 'Add the jurisdiction place.' : null}>
                  <Input id={ids('place')} value={place} maxLength={120} invalid={server.has(VF.jurisdictionPlace)} onChange={(ev) => setPlace(ev.currentTarget.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {many ? (
        <Fieldset legend={`Passengers (${list.length})`} columns={1}>
          <div className="hidden gap-2 text-[0.8125rem] font-semibold text-quiet sm:grid sm:grid-cols-[1.1fr_1.1fr_1fr_0.85fr_0.85fr]" aria-hidden="true">
            <span>Passenger</span>
            <span>Reference number</span>
            <span>Applied date</span>
            <span>Government fee ₹</span>
            <span>Service fee ₹ (optional)</span>
          </div>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-2.5 p-0">
            {list.map((a) => {
              const l = lines[a.applicationId]!;
              const who = nameOf(a);
              const cell = (key: 'reference' | 'appliedOn' | 'gov' | 'svc', k: string, label: string, errKey: string) => {
                const err = e(a, errKey, 'Check this value.');
                const input =
                  key === 'appliedOn' ? (
                    <Input id={fid(a, k)} type="date" max={today} value={l.appliedOn} aria-label={label} invalid={!!err} aria-describedby={err ? `${fid(a, k)}-error` : undefined} onChange={(ev) => setLine(a, key, ev.currentTarget.value)} />
                  ) : key === 'reference' ? (
                    <Input id={fid(a, k)} value={l.reference} maxLength={120} autoComplete="off" aria-label={label} placeholder="Reference number" invalid={!!err} aria-describedby={err ? `${fid(a, k)}-error` : undefined} onChange={(ev) => setLine(a, key, ev.currentTarget.value)} />
                  ) : (
                    <MoneyInput id={fid(a, k)} value={l[key]} aria-label={label} placeholder={key === 'gov' ? 'Govt. fee' : 'Service fee'} invalid={!!err} aria-describedby={err ? `${fid(a, k)}-error` : undefined} onChange={(ev) => setLine(a, key, ev.currentTarget.value)} />
                  );
                const shortLabel = { reference: 'Reference number', appliedOn: 'Applied date', gov: 'Government fee ₹', svc: 'Service fee ₹ (optional)' }[key];
                return (
                  <div className={key === 'appliedOn' ? 'col-span-2 min-w-0 sm:col-span-1' : 'min-w-0'}>
                    {/* Phones: the column headings are hidden, so each box keeps a visible label (its name includes it). */}
                    <span aria-hidden="true" className="mb-0.5 block text-xs font-semibold text-quiet sm:hidden">
                      {shortLabel}
                    </span>
                    {input}
                    {err ? <FieldError id={`${fid(a, k)}-error`}>{err}</FieldError> : null}
                  </div>
                );
              };
              return (
                <li key={a.applicationId} className="m-0 grid grid-cols-2 items-start gap-2 sm:grid-cols-[1.1fr_1.1fr_1fr_0.85fr_0.85fr]">
                  <span className="col-span-2 flex min-w-0 flex-col sm:col-span-1">
                    <span className="font-semibold wrap-anywhere text-ink">{who}</span>
                    <span className="text-[0.8125rem] text-quiet">{a.passport ? (a.passport.number ?? 'Passport no. not recorded') : `Appointment ${dayText(a.appointment.date)}`}</span>
                  </span>
                  <div className="col-span-2 min-w-0 sm:col-span-1">{cell('reference', 'ref', `Reference number for ${who}`, 'reference')}</div>
                  {cell('appliedOn', 'on', `Applied date for ${who}`, 'appliedOn')}
                  {cell('gov', 'gov', `Government fee in rupees for ${who}`, 'governmentFee')}
                  {cell('svc', 'svc', `Service fee in rupees for ${who} (optional)`, 'serviceFee')}
                </li>
              );
            })}
          </ul>
          <p className="m-0 mt-[0.5rem] text-sm text-quiet">Applied dates are filled from each passenger’s appointment date. Fees typed for the first passenger fill the empty fee boxes below it. Change any of them.</p>
        </Fieldset>
      ) : null}
      <Fieldset legend="Fee details" columns={1}>
        <div className="grid gap-3 sm:grid-cols-2">
          {!many ? (
            <>
              <Field htmlFor={fid(list[0]!, 'gov')} label="Government fee" error={e(list[0]!, 'governmentFee', 'Check the government fee.')}>
                <MoneyInput id={fid(list[0]!, 'gov')} value={lines[list[0]!.applicationId]!.gov} invalid={!!e(list[0]!, 'governmentFee', 'x')} aria-describedby={fieldDescribedBy(fid(list[0]!, 'gov'), { error: e(list[0]!, 'governmentFee', 'x') })} onChange={(ev) => setLine(list[0]!, 'gov', ev.currentTarget.value)} />
              </Field>
              <Field htmlFor={fid(list[0]!, 'svc')} label="Service fee" optional error={e(list[0]!, 'serviceFee', 'Check the service fee.')}>
                <MoneyInput id={fid(list[0]!, 'svc')} value={lines[list[0]!.applicationId]!.svc} invalid={!!e(list[0]!, 'serviceFee', 'x')} aria-describedby={fieldDescribedBy(fid(list[0]!, 'svc'), { error: e(list[0]!, 'serviceFee', 'x') })} onChange={(ev) => setLine(list[0]!, 'svc', ev.currentTarget.value)} />
              </Field>
            </>
          ) : null}
          <Field htmlFor={ids('paid')} label="Paid by">
            <Select id={ids('paid')} value={paidBy} onChange={(ev) => setPaidBy(ev.currentTarget.value as VisaPaidBy)}>
              <option value="company">{PAID_BY_LABEL.company}</option>
              <option value="customer_direct">{PAID_BY_LABEL.customer_direct}</option>
            </Select>
          </Field>
          {paidBy === 'company' ? (
            <Field htmlFor={ids('mode')} label="How it was paid" error={problems.some((p) => p.fieldId === ids('mode')) || server.has(VF.paymentMode) ? 'Choose how the fee was paid.' : null}>
              <Select id={ids('mode')} value={mode} invalid={server.has(VF.paymentMode) || problems.some((p) => p.fieldId === ids('mode'))} onChange={(ev) => setMode(ev.currentTarget.value)}>
                <option value="">Choose</option>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <FileField
              id={ids('file')}
              label={many ? 'Fee receipt (one receipt for all)' : 'Fee receipt'}
              optional
              file={file}
              keptName={receipt?.fileName ?? null}
              onFile={(f) => {
                setFile(f);
                setReceipt(null);
              }}
              error={problems.find((p) => p.fieldId === ids('file'))?.text as string | undefined ?? (server.has(VF.receiptEvidenceId) ? 'Choose the receipt again.' : null)}
            />
          </div>
        </div>
      </Fieldset>
      <Field htmlFor={ids('remark')} label="Remark" optional>
        <Input id={ids('remark')} value={remark} maxLength={300} onChange={(ev) => setRemark(ev.currentTarget.value)} />
      </Field>
      <p className="m-0 text-sm text-quiet">Company-paid fees go to Accounts for review once the receipt is attached. Customer-paid fees are recorded only.</p>
    </VisaPopup>
  );
}
