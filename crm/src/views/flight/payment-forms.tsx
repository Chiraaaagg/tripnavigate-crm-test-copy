'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Submit, UnavailableAction, type UiResult } from '@/views/accounts/supplier-forms';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { FF, type FlightWorkActions } from './actions';
import { inr } from './format';
import { ActionForm, messageOf } from './kit';
import type { FlightPaymentContext, MoneyBatch } from './types';

/*
 * Flight payment drawers (contract 11.1 "Cost and payment", B9/B10):
 * "Record direct payment" (within ₹50,000 for this supplier on this Deal,
 * counted together with its live payment requests) and "Raise payment
 * request" (routes to Accounts, or to the branch Manager above ₹50,000).
 * Both reuse the CRM's side drawer (focus trap, Escape, focus return). The
 * route text comes from the server (flight_payment_context); Flight never
 * sees customer money here.
 */

const MODES: Array<[string, string]> = [
  ['bank_transfer', 'Bank transfer'],
  ['upi', 'UPI'],
  ['card', 'Card'],
  ['cash', 'Cash'],
  ['other', 'Other'],
];

const PROOF_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

/** When an old manual fare record already paid part of the batch, the amount is what is still to pay; say so. */
function legacyNote(ctx: FlightPaymentContext): string {
  if (!ctx.legacyPaidPaise || BigInt(ctx.legacyPaidPaise) <= 0n) return '';
  return ` (still to pay: supplier cost ${inr(ctx.supplierCostPaise)} less ${inr(ctx.legacyPaidPaise)} paid earlier through an old fare record)`;
}

function Lbl({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="text-sm font-semibold text-ink">
      {children}
    </label>
  );
}

export function DirectPaymentDrawer({ batch, ctx, actions }: { batch: MoneyBatch; ctx: FlightPaymentContext | null; actions: FlightWorkActions }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [reference, setReference] = useState('');
  const [proofs, setProofs] = useState(ctx?.proofs ?? []);
  const [proofId, setProofId] = useState(ctx?.proofs.at(-1)?.evidenceId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!ctx) return <UnavailableAction label="Record direct payment" reason="The payment details did not load. Reload the page." />;
  if (!ctx.directAllowed) {
    return <UnavailableAction label="Record direct payment" reason="Above ₹50,000 for this supplier on this Deal: raise a payment request." />;
  }
  const returned = batch.payment.state === 'direct_returned';
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="secondary">{returned ? 'Fix and send the payment again' : 'Record direct payment'}</Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Record direct payment · batch {batch.batchNo}</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            You paid {ctx.supplierName} {inr(ctx.amountPaise)}{legacyNote(ctx)}. Accounts checks it afterwards. The CRM sends no money.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={actions.saveDirectPayment}
          fields={{
            [FF.batchId]: batch.batchId,
            [FF.expectedRowVersion]: batch.payment.entryRowVersion ?? 0,
            [FF.payload]: JSON.stringify({ paymentMode: mode, paidOn, reference: reference.trim() || null, proofEvidenceId: proofId || null }),
          }}
          label="Record direct payment"
          className="flex flex-1 flex-col"
          onDone={() => setOpen(false)}
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (!mode) errs.mode = 'Choose how you paid.';
            if (!paidOn) errs.paidOn = 'Enter the date you paid.';
            else if (paidOn > todayInIndia()) errs.paidOn = 'The date cannot be in the future.';
            if (!proofId) errs.proof = 'Attach the payment proof first.';
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          <DrawerBody className="flex flex-col gap-4">
            <Notice tone="info">
              <p>Within ₹50,000 for this supplier on this Deal: pay directly. So far for this supplier: {inr(ctx.runningTotalPaise)}.</p>
            </Notice>
            {batch.payment.returnReason ? (
              <Notice tone="danger" title="Accounts returned it">
                <p>{batch.payment.returnReason}</p>
              </Notice>
            ) : null}
            <div className="flex flex-col gap-1">
              <Lbl id={`${base}-mode`}>Paid by</Lbl>
              <Select id={`${base}-mode`} value={mode} onChange={(e) => setMode(e.target.value)} invalid={!!errors.mode}>
                <option value="">Choose</option>
                {MODES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
              {errors.mode ? <span className="text-sm font-medium text-status-danger">{errors.mode}</span> : null}
            </div>
            <div className="flex flex-col gap-1">
              <Lbl id={`${base}-paidOn`}>Paid on</Lbl>
              <Input id={`${base}-paidOn`} type="date" max={todayInIndia()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} invalid={!!errors.paidOn} />
              {errors.paidOn ? <span className="text-sm font-medium text-status-danger">{errors.paidOn}</span> : null}
            </div>
            <div className="flex flex-col gap-1">
              <Lbl id={`${base}-ref`}>Reference (optional)</Lbl>
              <Input id={`${base}-ref`} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <ProofPicker
              idBase={base}
              taskId={batch.costTaskId}
              proofs={proofs}
              value={proofId}
              onChange={setProofId}
              onUploaded={(p) => {
                setProofs((x) => [...x, p]);
                setProofId(p.evidenceId);
              }}
              error={errors.proof}
              upload={actions.uploadFile}
            />
          </DrawerBody>
          <DrawerFooter>
            <Submit label="Record direct payment" pendingLabel="Recording…" />
          </DrawerFooter>
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}

function ProofPicker({
  idBase,
  taskId,
  proofs,
  value,
  onChange,
  onUploaded,
  error,
  upload,
}: {
  idBase: string;
  taskId: string;
  proofs: Array<{ evidenceId: string; fileName: string }>;
  value: string;
  onChange: (v: string) => void;
  onUploaded: (p: { evidenceId: string; fileName: string }) => void;
  error?: string;
  upload: FlightWorkActions['uploadFile'];
}) {
  const file = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UiResult | null>(null);
  const [pending, setPending] = useState(false);
  const send = async () => {
    const f = file.current?.files?.[0];
    if (!f || pending) return;
    if (f.size > 4 * 1024 * 1024) {
      setState({ ok: false, code: 'invalid_input', message: 'The file is larger than 4 MB.' });
      return;
    }
    setPending(true);
    const fd = new FormData();
    fd.set(FF.taskId, taskId);
    fd.set(FF.kind, 'direct_payment_proof');
    fd.set(FF.file, f);
    fd.set(FF.requestId, crypto.randomUUID());
    try {
      const r = await upload(null as never, fd);
      setState(r);
      const id = r.ok ? (r.data as { evidenceId?: string } | undefined)?.evidenceId : undefined;
      if (id) {
        onUploaded({ evidenceId: id, fileName: f.name });
        if (file.current) file.current.value = '';
      }
    } catch {
      setState({ ok: false, code: 'unexpected', message: 'We could not confirm the upload. Reload the page to see what was saved.' });
    } finally {
      setPending(false);
    }
  };
  return (
    <fieldset id={`${idBase}-proof`} tabIndex={-1} className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-semibold text-ink">Payment proof</legend>
      {proofs.length ? (
        <Select aria-label="Payment proof on file" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a proof</option>
          {proofs.map((p) => (
            <option key={p.evidenceId} value={p.evidenceId}>
              {p.fileName}
            </option>
          ))}
        </Select>
      ) : (
        <p className="m-0 text-sm text-quiet">No proof attached yet.</p>
      )}
      <label htmlFor={`${idBase}-file`} className="text-sm text-copy">
        Attach a new proof (PDF, JPG, PNG or WebP, up to 4 MB)
      </label>
      <input id={`${idBase}-file`} ref={file} type="file" accept={PROOF_ACCEPT} className="text-sm" />
      <div>
        <Button size="sm" variant="secondary" onClick={send} aria-disabled={pending || undefined}>
          {pending ? 'Attaching…' : 'Attach proof'}
        </Button>
      </div>
      {state ? (
        <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'm-0 text-sm' : 'm-0 text-sm font-medium text-status-danger'}>
          {messageOf(state)}
        </p>
      ) : null}
      {error ? <span className="text-sm font-medium text-status-danger">{error}</span> : null}
    </fieldset>
  );
}

export function PaymentRequestDrawer({ batch, ctx, actions }: { batch: MoneyBatch; ctx: FlightPaymentContext | null; actions: FlightWorkActions }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!ctx) return null;
  const toManager = ctx.routePreview === 'manager';
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant={ctx.directAllowed ? 'ghost' : 'secondary'}>Raise payment request</Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Payment request · batch {batch.batchNo}</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            Accounts pays {ctx.supplierName} {inr(ctx.amountPaise)}{legacyNote(ctx)} after approval. The CRM sends no money.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={actions.createPaymentRequest}
          fields={{ [FF.batchId]: batch.batchId, [FF.payload]: JSON.stringify({ dueDate: dueDate || null, note: note.trim() || null, proformaEvidenceId: null }) }}
          label="Raise payment request"
          className="flex flex-1 flex-col"
          onDone={() => setOpen(false)}
          onSubmit={(e) => {
            const errs: Record<string, string> = {};
            if (!dueDate) errs.due = 'Enter the date the supplier must be paid by.';
            if (note.trim().length > 500) errs.note = 'Keep the note under 500 characters.';
            setErrors(errs);
            const first = Object.keys(errs)[0];
            if (first) {
              e.preventDefault();
              document.getElementById(`${base}-${first}`)?.focus();
            }
          }}
        >
          <DrawerBody className="flex flex-col gap-4">
            <Notice tone={toManager ? 'warning' : 'info'}>
              <p>{toManager ? 'Goes to the branch Manager (above ₹50,000 for this supplier on this Deal).' : 'Goes to Accounts.'}</p>
            </Notice>
            <div className="flex flex-col gap-1">
              <Lbl id={`${base}-due`}>Pay by</Lbl>
              <Input id={`${base}-due`} type="date" min={todayInIndia()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} invalid={!!errors.due} />
              {errors.due ? <span className="text-sm font-medium text-status-danger">{errors.due}</span> : null}
            </div>
            <div className="flex flex-col gap-1">
              <Lbl id={`${base}-note`}>Note for the approver (optional)</Lbl>
              <Textarea id={`${base}-note`} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!errors.note} />
              {errors.note ? <span className="text-sm font-medium text-status-danger">{errors.note}</span> : null}
            </div>
            <p className="m-0 text-sm text-quiet">The confirmed fare breakup is the basis; a supplier document is optional.</p>
          </DrawerBody>
          <DrawerFooter>
            <Submit label="Send payment request" pendingLabel="Sending…" />
          </DrawerFooter>
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}
