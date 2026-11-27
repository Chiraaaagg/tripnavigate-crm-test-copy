'use client';

import { CircleCheck, Hourglass, Plus, RotateCcw } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { guard, Submit, type DecisionAction, type UiResult } from '@/views/accounts/supplier-forms';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { HandForm } from '@/components/hand-form';
import { inr, shortDate } from './format';
import { messageOf } from './kit';
import type { FlightMoney } from './types';

/*
 * Supplier invoices of the Deal's flights (decision 10: the invoice may come
 * after the tickets and after "done"; Accounts sees "Invoice missing" until
 * then). Same two-step pattern as the Purchase "Upload invoice or credit
 * note" drawer: the file is stored first (its own action returns the file
 * id, kept for a retry), then the invoice details are recorded against it.
 * Flight records invoices only: credit notes stay a Purchase document
 * (contract B11 item 5). Uploading pays nobody.
 */

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

const STATUS: Record<'uploaded' | 'accepted' | 'returned', { word: string; tone: 'warning' | 'success' | 'danger'; icon: typeof Hourglass }> = {
  uploaded: { word: 'Waiting for Accounts', tone: 'warning', icon: Hourglass },
  accepted: { word: 'Accepted by Accounts', tone: 'success', icon: CircleCheck },
  returned: { word: 'Returned by Accounts', tone: 'danger', icon: RotateCcw },
};

export interface InvoiceActions {
  /** Supplier-money file upload of a flight task (taskId, kind 'invoice', file, requestId) → data.evidenceId. */
  uploadSupplierFile: DecisionAction;
  /** Records the invoice (taskId, supplierId, number, docDate, totalRupees, gstIncluded, evidenceId, requestId). */
  saveInvoice: DecisionAction;
}

export function FlightInvoicesSection({ money, canUpload, actions, dealId }: { money: FlightMoney; canUpload: boolean; actions?: InvoiceActions; dealId: string }) {
  const invoices = money.invoices ?? [];
  const suppliers = [...new Map(money.batches.map((b) => [b.supplierId, { supplierId: b.supplierId, name: b.supplierName, taskId: b.costTaskId }])).values()];
  const nameOf = (id: string) => suppliers.find((s) => s.supplierId === id)?.name ?? 'Supplier';
  return (
    <section aria-labelledby="flight-invoices-heading" className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="flight-invoices-heading" className="m-0 text-base font-semibold text-ink">
          Supplier invoices
        </h3>
        {canUpload && actions && suppliers.length > 0 ? <InvoiceDrawer suppliers={suppliers} actions={actions} dealId={dealId} /> : null}
      </div>
      {money.invoiceMissing ? (
        <Notice tone="warning" title="Invoice missing">
          <p>The trip has ended and no supplier invoice is uploaded. Accounts sees this too. It does not block marking the flight done.</p>
        </Notice>
      ) : null}
      {invoices.length === 0 ? (
        <p className="m-0 text-sm text-quiet">{suppliers.length === 0 ? 'Invoices are added after the tickets are confirmed.' : 'No supplier invoice yet. It may come later.'}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Supplier invoices">
          {invoices.map((d) => {
            const s = STATUS[d.status as keyof typeof STATUS] ?? STATUS.uploaded;
            return (
              <li key={d.documentId} className="m-0 flex flex-wrap items-start justify-between gap-2 rounded-control bg-wash px-3 py-2 text-sm">
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium text-ink">Invoice {d.number}</span> · <span className="tabular-nums">{inr(d.totalPaise)}</span> · {nameOf(d.supplierId)} · dated {shortDate(d.docDate)}
                </span>
                <StatusBadge tone={s.tone} icon={s.icon} wrap>
                  <span className="sr-only">Accounts check: </span>
                  {s.word}
                </StatusBadge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function InvoiceDrawer({ suppliers, actions, dealId }: { suppliers: Array<{ supplierId: string; name: string; taskId: string }>; actions: InvoiceActions; dealId: string }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.supplierId ?? '');
  const [number, setNumber] = useState('');
  const [docDate, setDocDate] = useState('');
  const [total, setTotal] = useState('');
  const [gst, setGst] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<UiResult | null>(null);
  const [stored, setStored] = useState<{ evidenceId: string; taskId: string } | null>(null);
  const [uploadRequestId, setUploadRequestId] = useState(() => crypto.randomUUID());
  const [saveRequestId, setSaveRequestId] = useState(() => crypto.randomUUID());
  const file = useRef<HTMLInputElement | null>(null);
  const taskId = suppliers.find((s) => s.supplierId === supplierId)?.taskId ?? '';

  const run = async () => {
    const errs: Record<string, string> = {};
    if (!supplierId) errs.supplier = 'Choose the supplier.';
    if (!number.trim()) errs.number = 'Enter the invoice number.';
    if (!docDate) errs.date = 'Enter the date on the invoice.';
    else if (docDate > todayInIndia()) errs.date = 'The date cannot be in the future.';
    if (!total.trim()) errs.total = 'Enter the invoice total.';
    if (!(stored && stored.taskId === taskId) && !file.current?.files?.[0]) errs.file = 'Choose the invoice file.';
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    let evidenceId = stored && stored.taskId === taskId ? stored.evidenceId : null;
    if (!evidenceId) {
      const up = new FormData();
      up.set('taskId', taskId);
      up.set('dealId', dealId);
      up.set('kind', 'invoice');
      up.set('file', file.current!.files![0]!);
      up.set('requestId', uploadRequestId);
      const r = await guard(actions.uploadSupplierFile)(null, up);
      if (!r.ok) {
        setState(r);
        return;
      }
      evidenceId = (r as { data?: { evidenceId?: string } }).data?.evidenceId ?? null;
      if (!evidenceId) {
        setState({ ok: false, code: 'unexpected', message: 'We could not confirm the upload. Reload the page to check before you try again.' });
        return;
      }
      setStored({ evidenceId, taskId });
    }
    const fd = new FormData();
    fd.set('taskId', taskId);
    fd.set('dealId', dealId);
    fd.set('supplierId', supplierId);
    fd.set('number', number.trim());
    fd.set('docDate', docDate);
    fd.set('totalRupees', total);
    fd.set('gstIncluded', gst ? 'true' : 'false');
    fd.set('evidenceId', evidenceId);
    fd.set('requestId', saveRequestId);
    const r = await guard(actions.saveInvoice)(null, fd);
    setState(r);
    if (r.ok) {
      setStored(null);
      setUploadRequestId(crypto.randomUUID());
      setSaveRequestId(crypto.randomUUID());
    }
  };

  const err = (k: string) =>
    errors[k] ? (
      <span id={`${base}-${k}-error`} className="text-sm font-medium text-status-danger">
        {errors[k]}
      </span>
    ) : null;

  return (
    <Drawer open={open} onOpenChange={(o) => { setOpen(o); if (!o && state?.ok) setState(null); }}>
      <DrawerTrigger asChild>
        <Button variant="secondary" size="sm">
          <Plus aria-hidden="true" />
          Upload supplier invoice
        </Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`} className="w-[min(28rem,calc(100vw-1rem))]" closeLabel="Close without uploading">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Upload a supplier invoice</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            Accounts checks it. Uploading does not pay anyone.
          </DrawerDescription>
        </DrawerHeader>
        {state?.ok ? (
          <DrawerBody className="flex flex-col gap-3">
            <Notice tone="success" role="status">
              <p>{messageOf(state)}</p>
            </Notice>
            <div>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </DrawerBody>
        ) : (
          <HandForm action={run} noValidate aria-label="Upload a supplier invoice" className="flex flex-1 flex-col">
            <DrawerBody className="flex flex-col gap-4">
              {state && !state.ok ? (
                <Notice tone="danger" role="alert">
                  <p>
                    <strong>Not saved: </strong>
                    {messageOf(state)}
                  </p>
                </Notice>
              ) : null}
              {suppliers.length > 1 ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${base}-supplier`} className="text-sm font-semibold text-ink">
                    Supplier
                  </label>
                  <Select id={`${base}-supplier`} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} invalid={!!errors.supplier}>
                    {suppliers.map((s) => (
                      <option key={s.supplierId} value={s.supplierId}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  {err('supplier')}
                </div>
              ) : (
                <p className="m-0 text-sm">Supplier: {suppliers[0]?.name}</p>
              )}
              <div className="flex flex-col gap-1">
                <label htmlFor={`${base}-number`} className="text-sm font-semibold text-ink">
                  Invoice number
                </label>
                <Input id={`${base}-number`} value={number} maxLength={60} autoComplete="off" onChange={(e) => setNumber(e.target.value)} invalid={!!errors.number} aria-describedby={errors.number ? `${base}-number-error` : undefined} />
                {err('number')}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${base}-date`} className="text-sm font-semibold text-ink">
                  Date on the invoice
                </label>
                <Input id={`${base}-date`} type="date" max={todayInIndia()} value={docDate} onChange={(e) => setDocDate(e.target.value)} invalid={!!errors.date} aria-describedby={errors.date ? `${base}-date-error` : undefined} />
                {err('date')}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${base}-total`} className="text-sm font-semibold text-ink">
                  Total (₹)
                </label>
                <MoneyInput id={`${base}-total`} value={total} onChange={(e) => setTotal(e.target.value)} invalid={!!errors.total} aria-describedby={errors.total ? `${base}-total-error` : undefined} />
                {err('total')}
              </div>
              <label className="flex items-start gap-2 font-medium text-ink">
                <input type="checkbox" className="mt-1.5 size-4 accent-brand-strong" checked={gst} onChange={(e) => setGst(e.target.checked)} />
                The total includes GST
              </label>
              {stored && stored.taskId === taskId ? (
                <Notice tone="success" role="status">
                  <p>File stored. Press “Record invoice” again to finish.</p>
                </Notice>
              ) : (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${base}-file`} className="text-sm font-semibold text-ink">
                    File
                  </label>
                  <input id={`${base}-file`} ref={file} type="file" accept={ACCEPT} aria-describedby={`${base}-file-hint${errors.file ? ` ${base}-file-error` : ''}`} className="block w-full max-w-full text-base" />
                  <span id={`${base}-file-hint`} className="text-xs text-quiet">
                    PDF, JPG, PNG or WebP, up to 4 MB.
                  </span>
                  {err('file')}
                </div>
              )}
            </DrawerBody>
            <DrawerFooter>
              <Submit label="Record invoice" pendingLabel="Uploading…" />
            </DrawerFooter>
          </HandForm>
        )}
      </DrawerContent>
    </Drawer>
  );
}
