'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/choice';
import type { ErrorSummaryItem } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { guard } from '@/views/accounts/supplier-forms';
import { formOf, VF } from './actions';
import { dayText, EMAIL_PATTERN, fileProblem, todayIst } from './format';
import { CheckSummary, FileField, PopupFacts, RefusalSummary, refusedFields, useCommand, useIds, VisaPopup, type VisaResult } from './kit';
import { HANDOVER_LABEL, HANDOVER_METHODS, KIND_LABEL, nameOf } from './labels';
import type { WorkCtx } from './passengers';
import type { HandoverMethod, VisaApplicant } from './types';
import { appTarget, filesOf, isPassportTask, kindOf, methodText, type PopupSeed } from './work-model';

/*
 * Decision and handover popups (contract 11.1; HTML approveDrawer H:15186,
 * rejectDrawer H:15205, handoverDrawer H:15212 / H:15253, deliveredDrawer
 * H:15219) plus the new Withdraw popup (V4) and the Apply again confirm
 * (QB9). Changes from the HTML, all approved: the decision proof is required
 * for Approved and Rejected (V5); the e-visa e-mail is typed by the desk and
 * starts empty (QB2) and the CRM sends nothing; "How the passport goes back"
 * has no default (V7). A proof file chosen here is uploaded once and kept
 * for a retry. Every typed value stays after a refusal.
 */

interface PopupProps {
  ctx: WorkCtx;
  a: VisaApplicant;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  returnFocusId?: string;
}


function facts(ctx: WorkCtx, a: VisaApplicant, extra: Array<[string, string]> = []): Array<[string, string]> {
  return [
    ['Passenger', nameOf(a)],
    ...(a.passport ? [['Passport', a.passport.number ?? 'Not recorded'] as [string, string]] : []),
    ...(a.applied ? [['Reference', a.applied.reference ?? 'Not recorded'] as [string, string]] : []),
    ...(!isPassportTask(ctx.ws) && kindOf(a) ? [['Visa type', KIND_LABEL[kindOf(a)!]] as [string, string]] : []),
    ...extra,
  ];
}

/** "How the passport goes back" with no default, and the courier number when By courier. */
function HandoverFields({
  ids,
  method,
  setMethod,
  courier,
  setCourier,
  required,
  errors,
}: {
  ids: (n: string) => string;
  method: string;
  setMethod: (v: string) => void;
  courier: string;
  setCourier: (v: string) => void;
  required: boolean;
  errors: { method?: string | null; courier?: string | null };
}) {
  return (
    <>
      <Field
        htmlFor={ids('method')}
        label="How the passport goes back"
        optional={!required}
        hint={required ? undefined : 'Leave it for later if you do not know yet.'}
        error={errors.method}
      >
        <Select id={ids('method')} value={method} invalid={!!errors.method} aria-describedby={fieldDescribedBy(ids('method'), { hint: !required, error: errors.method })} onChange={(e) => setMethod(e.currentTarget.value)}>
          <option value="">{required ? 'Choose' : 'Not decided yet'}</option>
          {HANDOVER_METHODS.map((m) => (
            <option key={m} value={m}>
              {HANDOVER_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      {method === 'courier' ? (
        <Field htmlFor={ids('courier')} label="Courier number" hint="Saving with the number records the passport as sent." error={errors.courier}>
          <Input id={ids('courier')} value={courier} maxLength={80} autoComplete="off" invalid={!!errors.courier} aria-describedby={fieldDescribedBy(ids('courier'), { hint: true, error: errors.courier })} onChange={(e) => setCourier(e.currentTarget.value)} />
        </Field>
      ) : null}
    </>
  );
}

/** Optional handover fields ('' = not decided yet: nothing is sent). */
function handoverFields(method: string, courier: string): Record<string, string> {
  if (!method) return {};
  return method === 'courier' ? { [VF.handoverMethod]: method, [VF.courierNumber]: courier.trim() } : { [VF.handoverMethod]: method as HandoverMethod };
}

/** Upload a decision proof once; returns its evidence id (or the refusal, shown by the caller). */
async function uploadProof(ctx: WorkCtx, a: VisaApplicant, file: File): Promise<VisaResult> {
  const fd = formOf({ [VF.taskId]: ctx.ws.taskId, [VF.dealId]: ctx.ws.dealId, [VF.applicationId]: a.applicationId, [VF.kind]: 'authority_outcome', [VF.file]: file });
  return (await guard(ctx.actions.uploadEvidence)(null, fd)) as VisaResult;
}

function useProof(ctx: WorkCtx, a: VisaApplicant) {
  const onFile = filesOf(ctx.ws, a, 'authority_outcome')[0] ?? null;
  const [file, setFile] = useState<File | null>(null);
  const [stored, setStored] = useState<{ evidenceId: string; fileName: string } | null>(onFile ? { evidenceId: onFile.evidenceId, fileName: onFile.fileName } : null);
  const ensure = async (setRefusal: (r: VisaResult) => void): Promise<string | null> => {
    if (stored) return stored.evidenceId;
    if (!file) return null;
    const r = await uploadProof(ctx, a, file);
    if (!r.ok) {
      setRefusal(r);
      return null;
    }
    const d = (r.data ?? {}) as { evidenceId?: string; fileName?: string };
    if (!d.evidenceId) return null;
    setStored({ evidenceId: d.evidenceId, fileName: d.fileName ?? file.name });
    return d.evidenceId;
  };
  return { onFile, file, setFile: (f: File | null) => { setFile(f); if (!onFile) setStored(null); }, stored, ensure };
}

export function ApprovePopup({ ctx, a, open, onOpenChange, returnFocusId, seed }: PopupProps & { seed?: PopupSeed }) {
  const ids = useIds('approve');
  const cmd = useCommand(ctx.actions.decide, seed?.result ?? null);
  const proof = useProof(ctx, a);
  const passport = isPassportTask(ctx.ws);
  const known = kindOf(a);
  const [kind, setKind] = useState(known ?? '');
  const [email, setEmail] = useState(seed?.email ?? '');
  const [method, setMethod] = useState(seed?.handoverMethod ?? '');
  const [courier, setCourier] = useState(seed?.courierNumber ?? '');
  const [remark, setRemark] = useState(seed?.remark ?? '');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const effective = passport ? null : (kind || null);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (!passport && !known && !kind) p.push({ fieldId: ids('kind'), text: 'Choose which visa it is.' });
    const fp = proof.stored ? null : fileProblem(proof.file, true);
    if (fp) p.push({ fieldId: ids('file'), text: fp === 'Choose the file.' ? 'Upload the visa document.' : fp });
    if (effective === 'e_visa' && !EMAIL_PATTERN.test(email.trim())) p.push({ fieldId: ids('email'), text: 'Type the e-mail address you sent the e-visa to.' });
    if (method === 'courier' && !courier.trim()) p.push({ fieldId: ids('courier'), text: 'Type the courier number.' });
    if (remark.trim().length > 300) p.push({ fieldId: ids('remark'), text: 'Use at most 300 characters.' });
    setProblems(p);
    if (p.length) return;
    cmd.send(async (rid) => {
      const evidenceId = await proof.ensure(cmd.setState);
      if (!evidenceId) return null;
      return formOf(
        {
          ...appTarget(ctx.ws, a),
          [VF.decision]: 'approved',
          [VF.outcomeEvidenceId]: evidenceId,
          [VF.remark]: remark.trim(),
          [VF.visaKind]: !passport && !known ? kind : null,
          [VF.recipientEmail]: effective === 'e_visa' ? email.trim() : null,
          ...(effective === 'e_visa' ? {} : handoverFields(method, courier)),
        },
        rid,
      );
    });
  };
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title={passport ? 'Passport approved' : 'Approve visa'} description={nameOf(a)} formId={ids('form')} primaryLabel="Save approval" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!proof.file} />
      <PopupFacts rows={facts(ctx, a)} />
      {!passport && !known ? (
        <Field htmlFor={ids('kind')} label="Which visa is it?" error={has(ids('kind')) ?? (server.has(VF.visaKind) ? 'Choose which visa it is.' : null)}>
          <Select id={ids('kind')} value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="">Choose</option>
            <option value="e_visa">{KIND_LABEL.e_visa}</option>
            <option value="sticker">{KIND_LABEL.sticker}</option>
          </Select>
        </Field>
      ) : null}
      {proof.onFile ? (
        <p className="m-0 text-sm text-quiet">Visa document on file: {proof.onFile.fileName}</p>
      ) : (
        <FileField id={ids('file')} label={passport ? 'Proof of the passport' : 'Proof of visa'} hint="Required." file={proof.file} keptName={proof.stored?.fileName} onFile={proof.setFile} error={has(ids('file')) ?? (server.has(VF.outcomeEvidenceId) || cmd.state?.ok === false && cmd.state.code === 'outcome_document_required' ? 'Upload the visa document.' : null)} />
      )}
      {effective === 'e_visa' ? (
        <Field htmlFor={ids('email')} label="Customer e-mail" hint="Record where you sent the e-visa. The CRM does not send it." error={has(ids('email')) ?? (server.has(VF.recipientEmail) ? 'Check the e-mail address.' : null)}>
          <Input id={ids('email')} type="email" value={email} maxLength={200} autoComplete="off" invalid={!!has(ids('email')) || server.has(VF.recipientEmail)} aria-describedby={fieldDescribedBy(ids('email'), { hint: true, error: has(ids('email')) })} onChange={(e) => setEmail(e.currentTarget.value)} />
        </Field>
      ) : effective === 'sticker' || passport ? (
        <HandoverFields ids={ids} method={method} setMethod={setMethod} courier={courier} setCourier={setCourier} required={false} errors={{ courier: has(ids('courier')) ?? (server.has(VF.courierNumber) ? 'Type the courier number.' : null) }} />
      ) : null}
      <Field htmlFor={ids('remark')} label="Remark" optional error={has(ids('remark'))}>
        <Input id={ids('remark')} value={remark} maxLength={300} onChange={(e) => setRemark(e.currentTarget.value)} />
      </Field>
    </VisaPopup>
  );
}

export function RejectPopup({ ctx, a, open, onOpenChange, returnFocusId }: PopupProps) {
  const ids = useIds('reject');
  const cmd = useCommand(ctx.actions.decide);
  const proof = useProof(ctx, a);
  const passport = isPassportTask(ctx.ws);
  const kind = kindOf(a);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [courier, setCourier] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const physical = passport || kind === 'sticker' || kind === null;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    const r = reason.trim();
    if (r.length < 3 || r.length > 300) p.push({ fieldId: ids('reason'), text: 'Write the reason: 3 to 300 characters.' });
    const fp = proof.stored ? null : fileProblem(proof.file, true);
    if (fp) p.push({ fieldId: ids('file'), text: fp === 'Choose the file.' ? 'Upload the refusal letter.' : fp });
    if (method === 'courier' && !courier.trim()) p.push({ fieldId: ids('courier'), text: 'Type the courier number.' });
    setProblems(p);
    if (p.length) return;
    cmd.send(async (rid) => {
      const evidenceId = await proof.ensure(cmd.setState);
      if (!evidenceId) return null;
      return formOf({ ...appTarget(ctx.ws, a), [VF.decision]: 'rejected', [VF.outcomeEvidenceId]: evidenceId, [VF.reason]: r, ...(physical ? handoverFields(method, courier) : {}) }, rid);
    });
  };
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title={passport ? 'Passport refused' : 'Reject visa'} description={nameOf(a)} formId={ids('form')} primaryLabel="Save rejection" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!proof.file} />
      <PopupFacts rows={facts(ctx, a)} />
      <Field htmlFor={ids('reason')} label="Reason for the refusal" hint="Sales sees this reason on the Deal." error={has(ids('reason')) ?? (server.has(VF.reason) ? 'Write the reason: 3 to 300 characters.' : null)}>
        <Textarea id={ids('reason')} rows={3} value={reason} maxLength={300} invalid={!!has(ids('reason')) || server.has(VF.reason)} aria-describedby={fieldDescribedBy(ids('reason'), { hint: true, error: has(ids('reason')) })} onChange={(e) => setReason(e.currentTarget.value)} />
      </Field>
      {proof.onFile ? (
        <p className="m-0 text-sm text-quiet">Document on file: {proof.onFile.fileName}</p>
      ) : (
        <FileField id={ids('file')} label="Refusal letter" hint="Required." file={proof.file} keptName={proof.stored?.fileName} onFile={proof.setFile} error={has(ids('file')) ?? (cmd.state?.ok === false && cmd.state.code === 'outcome_document_required' ? 'Upload the refusal letter.' : null)} />
      )}
      {physical ? (
        <HandoverFields ids={ids} method={method} setMethod={setMethod} courier={courier} setCourier={setCourier} required={false} errors={{ courier: has(ids('courier')) ?? (server.has(VF.courierNumber) ? 'Type the courier number.' : null) }} />
      ) : (
        <p className="m-0 text-sm text-quiet">Saving records that the customer was told.</p>
      )}
    </VisaPopup>
  );
}

export function WithdrawPopup({ ctx, a, open, onOpenChange, returnFocusId }: PopupProps) {
  const ids = useIds('withdraw');
  const cmd = useCommand(ctx.actions.withdraw);
  const [reason, setReason] = useState('');
  const [told, setTold] = useState(false);
  const [method, setMethod] = useState('');
  const [courier, setCourier] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const withUs = !!a.applied?.passportTaken;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    const r = reason.trim();
    if (r.length < 3 || r.length > 300) p.push({ fieldId: ids('reason'), text: 'Write the reason: 3 to 300 characters.' });
    if (!told) p.push({ fieldId: ids('told'), text: 'Tick that the customer has been told.' });
    if (method === 'courier' && !courier.trim()) p.push({ fieldId: ids('courier'), text: 'Type the courier number.' });
    setProblems(p);
    if (p.length) return;
    cmd.send((rid) => formOf({ ...appTarget(ctx.ws, a), [VF.reason]: r, [VF.customerInformed]: true, ...(withUs ? handoverFields(method, courier) : {}) }, rid));
  };
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title="Withdrawn by customer" description={nameOf(a)} formId={ids('form')} primaryLabel="Save withdrawal" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} />
      <PopupFacts rows={facts(ctx, a)} />
      <Field htmlFor={ids('reason')} label="Reason" error={has(ids('reason')) ?? (server.has(VF.reason) ? 'Write the reason: 3 to 300 characters.' : null)}>
        <Textarea id={ids('reason')} rows={3} value={reason} maxLength={300} invalid={!!has(ids('reason')) || server.has(VF.reason)} onChange={(e) => setReason(e.currentTarget.value)} />
      </Field>
      <Checkbox id={ids('told')} label="The customer has been told" checked={told} invalid={!!has(ids('told')) || server.has(VF.customerInformed)} description={has(ids('told'))} onChange={(e) => setTold(e.currentTarget.checked)} />
      {withUs ? (
        <HandoverFields ids={ids} method={method} setMethod={setMethod} courier={courier} setCourier={setCourier} required={false} errors={{ courier: has(ids('courier')) }} />
      ) : null}
      <p className="m-0 text-sm text-quiet">Saving closes this passenger. Fees stay as recorded; Accounts decides on any not yet accepted.</p>
    </VisaPopup>
  );
}

export function HandoverPopup({ ctx, a, open, onOpenChange, returnFocusId }: PopupProps) {
  const ids = useIds('handover');
  const cmd = useCommand(ctx.actions.setHandover);
  const passport = isPassportTask(ctx.ws);
  const kind = kindOf(a);
  const legacyEmail = !passport && kind === 'e_visa' && a.state === 'issued';
  const legacyTold = !passport && kind === 'e_visa' && a.state === 'refused';
  const [method, setMethod] = useState('');
  const [courier, setCourier] = useState('');
  const [email, setEmail] = useState('');
  const [told, setTold] = useState(false);
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (legacyEmail && !EMAIL_PATTERN.test(email.trim())) p.push({ fieldId: ids('email'), text: 'Type the e-mail address you sent the e-visa to.' });
    if (legacyTold && !told) p.push({ fieldId: ids('told'), text: 'Tick that the customer was told.' });
    if (!legacyEmail && !legacyTold) {
      if (!method) p.push({ fieldId: ids('method'), text: 'Choose how the passport goes back.' });
      if (method === 'courier' && !courier.trim()) p.push({ fieldId: ids('courier'), text: 'Type the courier number.' });
      if (remark.trim().length > 300) p.push({ fieldId: ids('remark'), text: 'Use at most 300 characters.' });
    }
    setProblems(p);
    if (p.length) return;
    const fields = legacyEmail
      ? { [VF.recipientEmail]: email.trim() }
      : legacyTold
        ? { [VF.customerTold]: true }
        : { ...handoverFields(method, courier), [VF.remark]: remark.trim() };
    cmd.send((rid) => formOf({ ...appTarget(ctx.ws, a), ...fields }, rid));
  };
  return (
    <VisaPopup
      open={open}
      onOpenChange={onOpenChange}
      title={legacyEmail ? 'Record the e-visa sent' : legacyTold ? 'Record that the customer was told' : 'How the passport goes back'}
      description={nameOf(a)}
      formId={ids('form')}
      primaryLabel="Save"
      pending={cmd.pending}
      onSubmit={submit}
      returnFocusId={returnFocusId}
      result={cmd.state}
      onDone={ctx.done}
    >
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} />
      <PopupFacts rows={facts(ctx, a)} />
      {legacyEmail ? (
        <Field htmlFor={ids('email')} label="Customer e-mail" hint="Record where you sent the e-visa. The CRM does not send it." error={has(ids('email')) ?? (server.has(VF.recipientEmail) ? 'Check the e-mail address.' : null)}>
          <Input id={ids('email')} type="email" value={email} maxLength={200} autoComplete="off" invalid={!!has(ids('email'))} aria-describedby={fieldDescribedBy(ids('email'), { hint: true, error: has(ids('email')) })} onChange={(e) => setEmail(e.currentTarget.value)} />
        </Field>
      ) : legacyTold ? (
        <Checkbox id={ids('told')} label="Customer told about the refusal" checked={told} invalid={!!has(ids('told'))} description={has(ids('told'))} onChange={(e) => setTold(e.currentTarget.checked)} />
      ) : (
        <>
          <HandoverFields ids={ids} method={method} setMethod={setMethod} courier={courier} setCourier={setCourier} required errors={{ method: has(ids('method')) ?? (server.has(VF.handoverMethod) ? 'Choose how the passport goes back.' : null), courier: has(ids('courier')) ?? (server.has(VF.courierNumber) ? 'Type the courier number.' : null) }} />
          <Field htmlFor={ids('remark')} label="Remark" optional error={has(ids('remark'))}>
            <Input id={ids('remark')} value={remark} maxLength={300} onChange={(e) => setRemark(e.currentTarget.value)} />
          </Field>
          <p className="m-0 text-sm text-quiet">“Passport is not with us” and “By courier” with a number close this passenger. Office and executive close when you mark it delivered.</p>
        </>
      )}
    </VisaPopup>
  );
}

export function DeliveredPopup({ ctx, a, open, onOpenChange, returnFocusId }: PopupProps) {
  const ids = useIds('delivered');
  const cmd = useCommand(ctx.actions.markDelivered);
  const today = todayIst();
  const [on, setOn] = useState(today);
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) p.push({ fieldId: ids('on'), text: 'Set the delivery date.' });
    else if (on > today) p.push({ fieldId: ids('on'), text: 'The delivery date cannot be after today.' });
    else if (a.applied?.appliedOn && on < a.applied.appliedOn) p.push({ fieldId: ids('on'), text: `The delivery date cannot be before the applied date (${dayText(a.applied.appliedOn)}).` });
    setProblems(p);
    if (p.length) return;
    cmd.send((rid) => formOf({ ...appTarget(ctx.ws, a), [VF.deliveredOn]: on, [VF.remark]: remark.trim() }, rid));
  };
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title="Mark delivered" description={nameOf(a)} formId={ids('form')} primaryLabel="Save delivery" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} />
      <PopupFacts rows={[['Passenger', nameOf(a)], ['How it goes back', methodText(a) ?? 'Not decided yet']]} />
      <Field htmlFor={ids('on')} label="Delivered on" error={has(ids('on')) ?? (server.has(VF.deliveredOn) ? 'Check the delivery date.' : null)}>
        <Input id={ids('on')} type="date" max={today} value={on} invalid={!!has(ids('on')) || server.has(VF.deliveredOn)} aria-describedby={fieldDescribedBy(ids('on'), { error: has(ids('on')) })} onChange={(e) => setOn(e.currentTarget.value)} />
      </Field>
      <Field htmlFor={ids('remark')} label="Remark" optional>
        <Input id={ids('remark')} value={remark} maxLength={300} onChange={(e) => setRemark(e.currentTarget.value)} />
      </Field>
    </VisaPopup>
  );
}

export function ReapplyPopup({ ctx, a, open, onOpenChange, returnFocusId }: PopupProps) {
  const ids = useIds('reapply');
  const cmd = useCommand(ctx.actions.reapply);
  return (
    <VisaPopup
      open={open}
      onOpenChange={onOpenChange}
      title="Apply again"
      description={`Start a new application for ${nameOf(a)}? The rejected one stays in History.`}
      formId={ids('form')}
      primaryLabel="Start a new application"
      pending={cmd.pending}
      onSubmit={() => cmd.send((rid) => formOf(appTarget(ctx.ws, a), rid))}
      returnFocusId={returnFocusId}
      result={cmd.state}
      onDone={ctx.done}
    >
      <RefusalSummary state={cmd.state} />
      <p className="m-0 text-copy">The documents and their received ticks are copied to the new application. It needs a new reference and new fees when you apply.</p>
    </VisaPopup>
  );
}
