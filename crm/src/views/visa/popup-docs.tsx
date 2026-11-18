'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/choice';
import type { ErrorSummaryItem } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { guard } from '@/views/accounts/supplier-forms';
import { formOf, VF } from './actions';
import { fileProblem, inr, labelKey, paiseToRupeesText, rupeesToPaise, todayIst } from './format';
import { CheckSummary, FileField, PopupFacts, RefusalSummary, refusedFields, useCommand, useIds, VisaPopup, type VisaResult } from './kit';
import { COST_KIND_LABEL, nameOf, PAID_BY_LABEL, PAYMENT_MODE_LABEL, PAYMENT_MODES, plural } from './labels';
import type { WorkCtx } from './passengers';
import type { VisaApplicant, VisaFee, VisaReturnedFee } from './types';
import { appTarget } from './work-model';

/*
 * Document and fee popups (contract 11.1; HTML addDocDrawer H:15104,
 * docUploadDrawer H:14715, feeFixDrawer H:15224). Add document: a catalogue
 * document not already on the list, or "Other" with a typed name. Upload:
 * which document (or a new "Other" one), the file; saving marks it
 * received. Remove: a not-received document only, after a confirm. Fix fee /
 * Send fee to Accounts: amount and a receipt (required when none is stored).
 * Typed values and a chosen file stay after a refusal; a step that already
 * succeeded (a new document, an uploaded receipt) is not repeated on retry.
 */

interface DocProps {
  ctx: WorkCtx;
  a: VisaApplicant;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  returnFocusId?: string;
}

const OTHER = '__other';

export function AddDocumentPopup({ ctx, a, open, onOpenChange, returnFocusId }: DocProps) {
  const ids = useIds('adddoc');
  const cmd = useCommand(ctx.actions.addDocument);
  const have = new Set(a.documents.map((d) => labelKey(d.label)));
  const choices = (ctx.ws.catalogue ?? []).filter((c) => !have.has(labelKey(c.label)));
  const [pick, setPick] = useState(choices[0]?.code ?? OTHER);
  const [label, setLabel] = useState('');
  const [received, setReceived] = useState(false);
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const dup = cmd.state?.ok === false && cmd.state.code === 'duplicate_document';
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (pick === OTHER) {
      const t = label.trim();
      if (!t) p.push({ fieldId: ids('label'), text: 'Type the document name.' });
      else if (t.length > 120) p.push({ fieldId: ids('label'), text: 'Use at most 120 characters.' });
      else if (have.has(labelKey(t))) p.push({ fieldId: ids('label'), text: 'This document is already on the list.' });
    }
    setProblems(p);
    if (p.length) return;
    const fields = { ...(pick === OTHER ? { [VF.catalogueCode]: 'other', [VF.label]: label.trim() } : { [VF.catalogueCode]: pick }), [VF.received]: received, [VF.remark]: remark.trim() };
    cmd.send((rid) => formOf({ ...appTarget(ctx.ws, a), ...fields }, rid));
  };
  const labelErr = (problems.find((p) => p.fieldId === ids('label'))?.text as string | undefined) ?? (dup || server.has(VF.label) ? 'This document is already on the list.' : null);
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title="Add document" description={nameOf(a)} formId={ids('form')} primaryLabel="Save document" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} />
      <Field htmlFor={ids('pick')} label="Document" hint={a.documents.length ? `${plural(a.documents.length, 'document')} already on the list are left out.` : undefined}>
        <Select id={ids('pick')} value={pick} aria-describedby={fieldDescribedBy(ids('pick'), { hint: a.documents.length > 0 })} onChange={(e) => setPick(e.currentTarget.value)}>
          {choices.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
          <option value={OTHER}>Other (type the name)</option>
        </Select>
      </Field>
      {pick === OTHER ? (
        <Field htmlFor={ids('label')} label="Document name" error={labelErr}>
          <Input id={ids('label')} value={label} maxLength={120} invalid={!!labelErr} aria-describedby={fieldDescribedBy(ids('label'), { error: labelErr })} onChange={(e) => setLabel(e.currentTarget.value)} />
        </Field>
      ) : null}
      <Checkbox id={ids('rec')} label="Already received" checked={received} onChange={(e) => setReceived(e.currentTarget.checked)} />
      <Field htmlFor={ids('remark')} label="Remark" optional>
        <Input id={ids('remark')} value={remark} maxLength={300} onChange={(e) => setRemark(e.currentTarget.value)} />
      </Field>
    </VisaPopup>
  );
}

export function UploadDocumentPopup({ ctx, a, open, onOpenChange, returnFocusId, documentId }: DocProps & { documentId?: string }) {
  const ids = useIds('updoc');
  const cmd = useCommand(ctx.actions.uploadDocument);
  const ordered = [...a.documents.filter((d) => d.status !== 'received'), ...a.documents.filter((d) => d.status === 'received')];
  const [pick, setPick] = useState(documentId ?? ordered[0]?.documentId ?? OTHER);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [created, setCreated] = useState<{ key: string; documentId: string; rowVersion: number } | null>(null);
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const editable = a.can.edit;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (pick === OTHER && !label.trim()) p.push({ fieldId: ids('label'), text: 'Type the document name.' });
    else if (pick === OTHER && a.documents.some((d) => labelKey(d.label) === labelKey(label))) p.push({ fieldId: ids('label'), text: 'This document is already on the list. Choose it above.' });
    const fp = fileProblem(file, true);
    if (fp) p.push({ fieldId: ids('file'), text: fp });
    setProblems(p);
    if (p.length) return;
    cmd.send(async (rid) => {
      let docId = pick;
      let version = created?.rowVersion ?? a.rowVersion;
      if (pick === OTHER) {
        const key = labelKey(label);
        if (created?.key === key) docId = created.documentId;
        else {
          const r = (await guard(ctx.actions.addDocument)(
            null,
            formOf({ ...appTarget(ctx.ws, a), [VF.catalogueCode]: 'other', [VF.label]: label.trim(), [VF.received]: false }, rid),
          )) as VisaResult;
          if (!r.ok) {
            cmd.setState(r);
            return null;
          }
          const d = (r.data ?? {}) as { documentId?: string | null; rowVersion?: number };
          if (!d.documentId) return null;
          docId = d.documentId;
          version = d.rowVersion ?? version;
          setCreated({ key, documentId: docId, rowVersion: version });
        }
      }
      const status = a.documents.find((d) => d.documentId === docId)?.status ?? 'not_received';
      return formOf({ taskId: ctx.ws.taskId, dealId: ctx.ws.dealId, applicationId: a.applicationId, expectedRowVersion: version, [VF.documentId]: docId, [VF.documentStatus]: status, [VF.file]: file! });
    });
  };
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title="Upload document" description={nameOf(a)} formId={ids('form')} primaryLabel="Upload and save" pendingLabel="Uploading…" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!file} />
      <PopupFacts rows={[['Passenger', nameOf(a)]]} />
      <Field htmlFor={ids('pick')} label="Which document">
        <Select id={ids('pick')} value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
          {ordered.map((d) => (
            <option key={d.documentId} value={d.documentId}>
              {d.label} · {d.status === 'received' ? 'Received' : 'Not received'}
            </option>
          ))}
          {editable ? <option value={OTHER}>Other document (not on the list)</option> : null}
        </Select>
      </Field>
      {pick === OTHER ? (
        <Field htmlFor={ids('label')} label="Document name" hint="Added to this passenger’s list." error={problems.find((p) => p.fieldId === ids('label'))?.text as string | undefined}>
          <Input id={ids('label')} value={label} maxLength={120} onChange={(e) => setLabel(e.currentTarget.value)} />
        </Field>
      ) : null}
      <FileField id={ids('file')} label="File" file={file} onFile={setFile} error={problems.find((p) => p.fieldId === ids('file'))?.text as string | undefined} />
      <p className="m-0 text-sm text-quiet">{editable ? 'Saving marks it received. Every view of the file is recorded.' : 'This passenger is past the document step, so only the file is added.'}</p>
    </VisaPopup>
  );
}

export function RemoveDocumentPopup({ ctx, a, documentId, open, onOpenChange, returnFocusId }: DocProps & { documentId: string }) {
  const ids = useIds('rmdoc');
  const cmd = useCommand(ctx.actions.removeDocument);
  const d = a.documents.find((x) => x.documentId === documentId);
  return (
    <VisaPopup
      open={open}
      onOpenChange={onOpenChange}
      title="Remove document"
      description={`Remove “${d?.label ?? 'this document'}” from ${nameOf(a)}’s list?`}
      formId={ids('form')}
      primaryLabel="Remove document"
      danger
      pending={cmd.pending}
      onSubmit={() => cmd.send((rid) => formOf({ ...appTarget(ctx.ws, a), [VF.documentId]: documentId }, rid))}
      returnFocusId={returnFocusId}
      result={cmd.state}
      onDone={ctx.done}
    >
      <RefusalSummary state={cmd.state} />
      <p className="m-0 text-copy">It stays in this task’s History. A received document cannot be removed.</p>
    </VisaPopup>
  );
}

export function FeePopup({ ctx, entryId, open, onOpenChange, returnFocusId }: { ctx: WorkCtx; entryId: string; open: boolean; onOpenChange: (o: boolean) => void; returnFocusId?: string }) {
  const ids = useIds('fee');
  const cmd = useCommand(ctx.actions.sendFee);
  const owner = ctx.ws.applicants.find((a) => a.fees.some((f) => f.entryId === entryId)) ?? null;
  const fee: VisaFee | undefined = owner?.fees.find((f) => f.entryId === entryId);
  const returned: VisaReturnedFee | undefined = ctx.ws.returnedFees.find((f) => f.entryId === entryId);
  const isDraft = fee?.expenseStatus === 'draft' && !returned;
  const hasReceipt = !!fee?.receipt;
  const amountPaise = returned?.amountPaise ?? fee?.amountPaise ?? '';
  const kind = returned?.costKind ?? fee?.costKind ?? 'government_fee';
  const rowVersion = returned?.rowVersion ?? fee?.rowVersion ?? 0;
  const [amount, setAmount] = useState(paiseToRupeesText(amountPaise));
  const [file, setFile] = useState<File | null>(null);
  const [stored, setStored] = useState<{ evidenceId: string; fileName: string } | null>(null);
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (!rupeesToPaise(amount)) p.push({ fieldId: ids('amount'), text: 'Type the amount in rupees, more than ₹0.' });
    const fp = stored ? null : fileProblem(file, !hasReceipt);
    if (fp) p.push({ fieldId: ids('file'), text: fp === 'Choose the file.' ? 'Attach the fee receipt.' : fp });
    if (remark.trim().length > 300) p.push({ fieldId: ids('remark'), text: 'Use at most 300 characters.' });
    setProblems(p);
    if (p.length) return;
    cmd.send(async (rid) => {
      let receiptId = stored?.evidenceId ?? null;
      if (!receiptId && file) {
        const fd = formOf({ [VF.taskId]: ctx.ws.taskId, [VF.dealId]: ctx.ws.dealId, [VF.applicationId]: owner?.applicationId, [VF.kind]: 'fee_receipt', [VF.file]: file });
        const r = (await guard(ctx.actions.uploadEvidence)(null, fd)) as VisaResult;
        if (!r.ok) {
          cmd.setState(r);
          return null;
        }
        const d = (r.data ?? {}) as { evidenceId?: string; fileName?: string };
        if (!d.evidenceId) return null;
        receiptId = d.evidenceId;
        setStored({ evidenceId: d.evidenceId, fileName: d.fileName ?? file.name });
      }
      return formOf({ [VF.taskId]: ctx.ws.taskId, [VF.dealId]: ctx.ws.dealId, [VF.entryId]: entryId, [VF.expectedRowVersion]: rowVersion, [VF.amount]: amount, [VF.receiptEvidenceId]: receiptId, [VF.remark]: remark.trim() }, rid);
    });
  };
  const amountErr = has(ids('amount')) ?? (server.has(VF.amount) ? 'Check the amount.' : null);
  const fileErr = has(ids('file')) ?? (cmd.state?.ok === false && cmd.state.code === 'receipt_required' ? 'Attach the fee receipt.' : null);
  return (
    <VisaPopup
      open={open}
      onOpenChange={onOpenChange}
      title={isDraft ? 'Send fee to Accounts' : 'Fix fee'}
      description={isDraft ? 'Attach the receipt and send this fee to Accounts for review.' : 'Corrects this fee and sends it back to Accounts.'}
      formId={ids('form')}
      primaryLabel="Send to Accounts"
      pending={cmd.pending}
      onSubmit={submit}
      returnFocusId={returnFocusId}
      result={cmd.state}
      onDone={ctx.done}
    >
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!file} />
      {returned ? <Notice tone="danger">Accounts returned it: {returned.returnReason || 'No reason given.'}</Notice> : null}
      <PopupFacts
        rows={[
          ['Fee', `${COST_KIND_LABEL[kind]}${owner ? ` · ${nameOf(owner)}` : returned?.applicantName ? ` · ${returned.applicantName}` : ''}`],
          ['Recorded amount', inr(amountPaise)],
          ['Current receipt', fee?.receipt?.fileName ?? (hasReceipt ? 'Stored' : 'None yet')],
        ]}
      />
      <Field htmlFor={ids('amount')} label="Amount" error={amountErr}>
        <MoneyInput id={ids('amount')} value={amount} invalid={!!amountErr} aria-describedby={fieldDescribedBy(ids('amount'), { error: amountErr })} onChange={(e) => setAmount(e.currentTarget.value)} />
      </Field>
      <FileField id={ids('file')} label={hasReceipt ? 'New fee receipt' : 'Fee receipt'} optional={hasReceipt} file={file} keptName={stored?.fileName} onFile={(f) => { setFile(f); setStored(null); }} error={fileErr} />
      <Field htmlFor={ids('remark')} label="Remark" optional hint="Accounts reads this." error={has(ids('remark'))}>
        <Input id={ids('remark')} value={remark} maxLength={300} aria-describedby={fieldDescribedBy(ids('remark'), { hint: true })} onChange={(e) => setRemark(e.currentTarget.value)} />
      </Field>
    </VisaPopup>
  );
}

/**
 * Other visa cost of one passenger (contract section 16, VL18 changed), for
 * example a courier: kind "other", linked to the passenger, same paid-by,
 * receipt and Accounts rules as fees. A company-paid one without a receipt
 * stays a draft until "Send fee to Accounts".
 */
export function OtherCostPopup({ ctx, a, open, onOpenChange, returnFocusId }: DocProps) {
  const ids = useIds('other');
  const cmd = useCommand(ctx.actions.saveOtherCost);
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState<'company' | 'customer_direct'>('company');
  const [mode, setMode] = useState('');
  const [paidOn, setPaidOn] = useState(todayIst());
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [stored, setStored] = useState<{ evidenceId: string; fileName: string } | null>(null);
  const [problems, setProblems] = useState<ErrorSummaryItem[]>([]);
  const server = refusedFields(cmd.state);
  const has = (id: string) => problems.find((p) => p.fieldId === id)?.text as string | undefined;
  const submit = () => {
    const p: ErrorSummaryItem[] = [];
    if (!rupeesToPaise(amount)) p.push({ fieldId: ids('amount'), text: 'Type the amount in rupees, more than ₹0.' });
    if (paidBy === 'company' && !mode) p.push({ fieldId: ids('mode'), text: 'Choose how it was paid.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) p.push({ fieldId: ids('on'), text: 'Set the date it was paid.' });
    const fp = stored ? null : fileProblem(file, false);
    if (fp) p.push({ fieldId: ids('file'), text: fp });
    setProblems(p);
    if (p.length) return;
    cmd.send(async (rid) => {
      let receiptId = stored?.evidenceId ?? null;
      if (!receiptId && file) {
        const r = (await guard(ctx.actions.uploadEvidence)(
          null,
          formOf({ [VF.taskId]: ctx.ws.taskId, [VF.dealId]: ctx.ws.dealId, [VF.applicationId]: a.applicationId, [VF.kind]: 'fee_receipt', [VF.file]: file }),
        )) as VisaResult;
        if (!r.ok) {
          cmd.setState(r);
          return null;
        }
        const d = (r.data ?? {}) as { evidenceId?: string };
        if (!d.evidenceId) return null;
        receiptId = d.evidenceId;
        setStored({ evidenceId: d.evidenceId, fileName: file.name });
      }
      return formOf(
        {
          [VF.taskId]: ctx.ws.taskId,
          [VF.dealId]: ctx.ws.dealId,
          [VF.applicationId]: a.applicationId,
          [VF.expectedRowVersion]: '0',
          [VF.amount]: amount,
          [VF.paidBy]: paidBy,
          [VF.paymentMode]: paidBy === 'company' ? mode : null,
          [VF.paidOn]: paidOn,
          [VF.reference]: reference.trim(),
          [VF.receiptEvidenceId]: receiptId,
        },
        rid,
      );
    });
  };
  const err = (id: string, key: string, text: string) => has(id) ?? (server.has(key) ? text : null);
  return (
    <VisaPopup open={open} onOpenChange={onOpenChange} title="Other visa cost" description={nameOf(a)} formId={ids('form')} primaryLabel="Save cost" pending={cmd.pending} onSubmit={submit} returnFocusId={returnFocusId} result={cmd.state} onDone={ctx.done}>
      <CheckSummary problems={problems} />
      <RefusalSummary state={problems.length ? null : cmd.state} keptFile={!!file} />
      <p className="m-0 text-sm text-quiet">For a cost of this passenger’s visa other than the government or service fee, for example a courier.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor={ids('amount')} label="Amount" error={err(ids('amount'), VF.amount, 'Check the amount.')}>
          <MoneyInput id={ids('amount')} value={amount} invalid={!!err(ids('amount'), VF.amount, 'x')} onChange={(e) => setAmount(e.currentTarget.value)} />
        </Field>
        <Field htmlFor={ids('on')} label="Paid on" error={err(ids('on'), VF.paidOn, 'Check the date.')}>
          <Input id={ids('on')} type="date" value={paidOn} max={todayIst()} onChange={(e) => setPaidOn(e.currentTarget.value)} />
        </Field>
        <Field htmlFor={ids('paid')} label="Paid by">
          <Select id={ids('paid')} value={paidBy} onChange={(e) => setPaidBy(e.currentTarget.value as 'company' | 'customer_direct')}>
            <option value="company">{PAID_BY_LABEL.company}</option>
            <option value="customer_direct">{PAID_BY_LABEL.customer_direct}</option>
          </Select>
        </Field>
        {paidBy === 'company' ? (
          <Field htmlFor={ids('mode')} label="How it was paid" error={err(ids('mode'), VF.paymentMode, 'Choose how it was paid.')}>
            <Select id={ids('mode')} value={mode} onChange={(e) => setMode(e.currentTarget.value)}>
              <option value="">Choose</option>
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field htmlFor={ids('ref')} label="Reference" optional>
          <Input id={ids('ref')} value={reference} maxLength={120} autoComplete="off" onChange={(e) => setReference(e.currentTarget.value)} />
        </Field>
      </div>
      <FileField id={ids('file')} label="Receipt" optional file={file} keptName={stored?.fileName} onFile={(f) => { setFile(f); setStored(null); }} error={has(ids('file'))} />
      <p className="m-0 text-sm text-quiet">Company-paid costs go to Accounts for review once the receipt is attached.</p>
    </VisaPopup>
  );
}
