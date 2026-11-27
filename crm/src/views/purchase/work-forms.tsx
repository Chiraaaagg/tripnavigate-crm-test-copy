'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useId, useState } from 'react';
import { HandForm, useSavedKey } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Input } from '@/components/ui/input';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Select } from '@/components/ui/select';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { formatPaise } from '@/modules/deals/dto';
import { paiseToRupeesInput } from '@/modules/fulfilment/forms';
import { PFIELD } from '@/modules/procurement/forms';
import {
  DOCUMENT_KIND_LABEL,
  NOTE_FOR_ACCOUNTS,
  PAYMENT_PART_LABEL,
  previewRoute,
  ROUTE_LABEL,
  ROUTE_NOTICE,
  SM_FIELD,
  SUPPLIER_MONEY_FILE_HINT,
  SUPPLIER_MONEY_MIME,
  SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT,
  type PaymentContextView,
  type SupplierDocumentKind,
  type SupplierPaymentPart,
} from '@/modules/supplier-money/contracts';
import { guard, Hidden, ResultLine, Submit, useRequestId, type DecisionAction, type UiResult } from '../accounts/supplier-forms';
import type { CatalogueHotelOption, CatalogueHotelSearch, QuoteCatalogueHotel } from '../suppliers/types';
import { rupeesToPaise, wholeStayFromPerNight } from './purchase-vm';
import { useWorkFlash } from './work-flash';
import { OfferContractBlock, type RawRateLookupAction } from '@/views/rate-contracts/offer-block';

/*
 * Client forms of the Purchase Work and Files tabs (Purchase build, Track C).
 * Every action arrives as a prop: the route passes the real server action,
 * the preview gallery a stub. One request id per form, renewed only after a
 * confirmed success. Refusals keep what was typed.
 */

const ACCEPT = SUPPLIER_MONEY_MIME.join(',');

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** "Add rate": supplier, amount for the whole stay (or per room per night, which fills it), short note. */
export function AddRateForm({
  taskId,
  action,
  suppliers,
  serviceName,
  rooms,
  nights,
  hotel,
  catalogue,
  searchHotels,
  contract,
}: {
  /**
   * Accounts phase 3 (contract 9.2, 9.3 E9, screen 15.9): the contract rate block for a hotel offer from
   * the hotel list. Absent or `enabled: false` = the form is exactly as before.
   */
  contract?: { enabled: boolean; rawLookup: RawRateLookupAction; stay: { checkIn: string; checkOut: string; rooms: number } } | null;
  taskId: string;
  action: DecisionAction;
  suppliers: Array<{ supplierId: string; name: string }>;
  /** Hotel name (hotel) or the service title: the offer is for this service. */
  serviceName: string;
  rooms: number;
  nights: number;
  hotel: boolean;
  /**
   * Accounts phase 2 (contract 13.4): the booking's catalogue hotel and the suppliers who sell it
   * (purchase_workspace). The hotel defaults to it and its suppliers are listed first.
   */
  catalogue?: QuoteCatalogueHotel | null;
  /** Hotel list type-ahead (another catalogue hotel may be chosen; free text stays allowed). */
  searchHotels?: CatalogueHotelSearch | null;
}) {
  const [state, run] = useActionState((prev: UiResult | null, fd: FormData) => guard(action)(prev as never, fd), null);
  const requestId = useRequestId(state);
  const base = useId();
  const picker = hotel && (!!catalogue || !!searchHotels);
  const [hotelText, setHotelText] = useState(catalogue?.catalogueHotelName ?? serviceName);
  const [hotelId, setHotelId] = useState(catalogue?.catalogueHotelId ?? '');
  const sellers = picker && catalogue && hotelId && hotelId === catalogue.catalogueHotelId ? catalogue.hotelSuppliers : [];
  const sellerIds = new Set(sellers.map((x) => x.supplierId));
  const firstGroup = suppliers.filter((x) => sellerIds.has(x.supplierId));
  const otherGroup = suppliers.filter((x) => !sellerIds.has(x.supplierId));
  const [supplierId, setSupplierId] = useState((firstGroup[0] ?? suppliers[0])?.supplierId ?? '');
  const [amount, setAmount] = useState('');
  const [perNight, setPerNight] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) {
      setAmount('');
      setPerNight('');
      setNote('');
    }
  }
  if (suppliers.length === 0) {
    return (
      <Notice tone="info">
        <p>
          No active supplier for this service yet. <Link href="/app/purchase/suppliers">Add a supplier</Link> first, then come back.
        </p>
      </Notice>
    );
  }
  const perNightHint = hotel ? `Optional. Fills the total for ${rooms} ${rooms === 1 ? 'room' : 'rooms'} × ${nights} ${nights === 1 ? 'night' : 'nights'}.` : undefined;
  return (
    <HandForm
      action={run}
      noValidate
      aria-label="Add a rate"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        if (!rupeesToPaise(amount)) {
          e.preventDefault();
          setProblem('Enter the supplier’s amount in rupees, for example 42000.');
          document.getElementById(`${base}-amount`)?.focus();
          return;
        }
        setProblem(null);
      }}
    >
      <ResultLine state={state} />
      <Hidden fields={picker ? { [PFIELD.taskId]: taskId, [PFIELD.requestId]: requestId, catalogueHotelId: hotelId } : { [PFIELD.taskId]: taskId, [PFIELD.requestId]: requestId, [PFIELD.hotelName]: serviceName }} />
      {picker ? (
        <Field
          htmlFor={`${base}-hotel`}
          label="Hotel offered"
          hint={hotelId ? (catalogue && hotelId === catalogue.catalogueHotelId ? 'The hotel Sales booked, from the hotel list.' : 'Chosen from the hotel list.') : 'Not from the hotel list: typed by hand.'}
        >
          {searchHotels ? (
            <SearchCombobox<CatalogueHotelOption>
              id={`${base}-hotel`}
              name={PFIELD.hotelName}
              value={hotelText}
              placeholder="Type 2 letters to search"
              onValueChange={(x) => {
                setHotelText(x);
                setHotelId('');
              }}
              search={searchHotels}
              keyOf={(h) => h.hotelId}
              textOf={(h) => [h.name, h.city, h.area, h.category].filter(Boolean).join(', ')}
              renderOption={(h) => (
                <>
                  <span className="font-semibold text-ink">{h.name}</span>
                  <span className="text-sm text-quiet">{[h.city, h.area, h.category].filter(Boolean).join(' · ')}</span>
                </>
              )}
              onPick={(h) => {
                setHotelText(h.name);
                setHotelId(h.hotelId);
              }}
              noMatchText="Not in the hotel list. Keep typing the name."
              maxLength={200}
              aria-describedby={`${base}-hotel-hint`}
            />
          ) : (
            <Input id={`${base}-hotel`} name={PFIELD.hotelName} value={hotelText} onChange={(e) => { setHotelText(e.target.value); setHotelId(e.target.value === catalogue?.catalogueHotelName ? (catalogue?.catalogueHotelId ?? '') : ''); }} maxLength={200} required aria-describedby={`${base}-hotel-hint`} />
          )}
        </Field>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field htmlFor={`${base}-supplier`} label="Supplier" hint={firstGroup.length > 0 ? 'Suppliers who sell this hotel come first.' : undefined}>
          <Select id={`${base}-supplier`} name={PFIELD.supplierId} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-describedby={firstGroup.length > 0 ? `${base}-supplier-hint` : undefined}>
            {firstGroup.length > 0 ? (
              <>
                <optgroup label="Sell this hotel">
                  {firstGroup.map((s) => (
                    <option key={s.supplierId} value={s.supplierId}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
                {otherGroup.length > 0 ? (
                  <optgroup label="Other suppliers">
                    {otherGroup.map((s) => (
                      <option key={s.supplierId} value={s.supplierId}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </>
            ) : (
              suppliers.map((s) => (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.name}
                </option>
              ))
            )}
          </Select>
        </Field>
        <Field htmlFor={`${base}-amount`} label={hotel ? 'Amount for the whole stay (₹)' : 'Amount for the service (₹)'} hint={hotel ? 'All rooms, all nights.' : undefined} error={problem}>
          <MoneyInput
            id={`${base}-amount`}
            name={PFIELD.quotedCostRupees}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            invalid={!!problem}
            aria-describedby={fieldDescribedBy(`${base}-amount`, { hint: hotel, error: problem })}
          />
        </Field>
        {hotel ? (
          <Field htmlFor={`${base}-pernight`} label="Or per room per night (₹)" hint={perNightHint}>
            <MoneyInput
              id={`${base}-pernight`}
              name={PFIELD.perRoomNightRupees}
              value={perNight}
              onChange={(e) => {
                setPerNight(e.target.value);
                const total = wholeStayFromPerNight(e.target.value, rooms, nights);
                if (total) setAmount(total);
              }}
              aria-describedby={`${base}-pernight-hint`}
            />
          </Field>
        ) : null}
      </div>
      {hotel && contract?.enabled ? (
        <OfferContractBlock
          enabled
          rawLookup={contract.rawLookup}
          taskId={taskId}
          supplierId={supplierId}
          hotelId={hotelId}
          hotelName={hotelId ? hotelText : null}
          stay={contract.stay}
          quotedRupees={amount}
          reasonError={state && !state.ok && (state as { field?: string }).field === 'contractDeviationReason' ? state.message : null}
        />
      ) : null}
      <Field htmlFor={`${base}-note`} label="Note" optional hint="For example: “Revised after our call” or “Includes the gala dinner”.">
        <Input id={`${base}-note`} name={PFIELD.quoteNote} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-describedby={`${base}-note-hint`} />
      </Field>
      <div>
        <Submit label="Add rate" pendingLabel="Adding…" variant="secondary" />
      </div>
    </HandForm>
  );
}

/** "Use as final rate": a new agreed cost version at this rate's amount (append-only). */
export function UseFinalRateForm({
  taskId,
  quoteId,
  amountPaise,
  latestVersionNo,
  supplierName,
  action,
}: {
  taskId: string;
  quoteId: string;
  amountPaise: string;
  latestVersionNo: number;
  supplierName: string;
  action: DecisionAction;
}) {
  const [state, run] = useActionState((prev: UiResult | null, fd: FormData) => guard(action)(prev as never, fd), null);
  const requestId = useRequestId(state);
  return (
    <HandForm action={run} noValidate aria-label={`Use the ${supplierName} rate as the final rate`} className="flex flex-col gap-2">
      <Hidden
        fields={{
          [PFIELD.taskId]: taskId,
          [PFIELD.quoteId]: quoteId,
          [PFIELD.amountRupees]: paiseToRupeesInput(amountPaise),
          [PFIELD.expectedVersionNo]: latestVersionNo,
          [PFIELD.requestId]: requestId,
        }}
      />
      <div>
        <Submit label="Use as final rate" pendingLabel="Saving…" variant="secondary" />
      </div>
      {state && !state.ok ? <ResultLine state={state} /> : null}
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Supplier payment request drawer
// ---------------------------------------------------------------------------

export interface ResubmitFrom {
  paymentId: string;
  refNo: string;
  part: SupplierPaymentPart;
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
}

/**
 * Amount, part, due date, the supplier's proforma (required) and a note.
 * The route notice updates as the amount is typed (B's previewRoute; the
 * database decides). An optional "Note for Accounts" says why the supplier
 * must be paid by the date; Purchase never sees any customer-money or
 * company-funding signal (review F1: the server decides funding itself).
 * The proforma is uploaded first; a refused request keeps it.
 */
export function PaymentRequestDrawer({
  ctx,
  triggerLabel,
  triggerVariant = 'primary',
  createAction,
  resubmitAction,
  uploadAction,
  resubmit,
}: {
  ctx: PaymentContextView;
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  createAction: DecisionAction;
  resubmitAction: DecisionAction;
  uploadAction: DecisionAction;
  /** "Change and send again" for a returned request: prefilled. */
  resubmit?: ResubmitFrom;
}) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const parts = ctx.allowedParts.length > 0 ? ctx.allowedParts : (['deposit'] as SupplierPaymentPart[]);
  const [part, setPart] = useState<SupplierPaymentPart>(resubmit && parts.includes(resubmit.part) ? resubmit.part : parts[0]!);
  const [amount, setAmount] = useState(resubmit ? paiseToRupeesInput(resubmit.amountPaise) : '');
  const [due, setDue] = useState(resubmit?.dueDate ?? '');
  const [note, setNote] = useState(resubmit?.note ?? '');
  const [reason, setReason] = useState('');
  const [proformaId, setProformaId] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ amount?: string; file?: string; reason?: string }>({});
  const [uploadRequestId] = useState(() => crypto.randomUUID());
  const flash = useWorkFlash();
  const [state, run] = useActionState(async (prev: UiResult | null, fd: FormData): Promise<UiResult> => {
    let evidenceId = proformaId;
    if (!evidenceId) {
      const file = fd.get(SM_FIELD.file);
      if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'invalid_input', message: 'Attach the supplier’s proforma or hold document.' };
      const up = new FormData();
      up.set(SM_FIELD.taskId, ctx.taskId);
      up.set(SM_FIELD.kind, 'proforma');
      up.set(SM_FIELD.file, file);
      up.set(SM_FIELD.requestId, uploadRequestId);
      const uploaded = await guard(uploadAction)(prev as never, up);
      if (!uploaded.ok) return uploaded;
      const data = (uploaded as { data?: { evidenceId?: string } }).data;
      if (!data?.evidenceId) return { ok: false, code: 'unexpected', message: SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT };
      evidenceId = data.evidenceId;
      setProformaId(evidenceId);
    }
    fd.set(SM_FIELD.proformaEvidenceId, evidenceId);
    fd.delete(SM_FIELD.file);
    const result = await guard(resubmit ? resubmitAction : createAction)(prev as never, fd);
    // A re-sent request replaces its row (and this drawer): keep the result on the page.
    if (result.ok) flash(result.message);
    return result;
  }, null);
  const requestId = useRequestId(state);
  const savedKey = useSavedKey(state && state.ok ? state : null);

  const amountPaise = rupeesToPaise(amount);
  const route = previewRoute(ctx.routeRunningTotalPaise, amountPaise ? amountPaise.toString() : '0');
  const field = (n: string) => `${base}-${n}`;
  const title = resubmit ? `Change and send again (${resubmit.refNo})` : 'Request a supplier payment';

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant={triggerVariant}>
          {resubmit ? null : <Plus aria-hidden="true" />}
          {triggerLabel}
        </Button>
      </DrawerTrigger>
      <DrawerContent className="w-[min(36rem,100vw)] max-sm:rounded-none" closeLabel="Close without sending">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
          <DrawerDescription className="m-0 text-sm text-quiet">
            {ctx.dealReference} · {ctx.serviceTitle}
            {ctx.supplierName ? ` · ${ctx.supplierName}` : ''}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-4">
          {state?.ok ? (
            <>
              <ResultLine state={state} />
              <div>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <HandForm
              action={run}
              noValidate
              aria-label={title}
              className="flex flex-col gap-4"
              encType="multipart/form-data"
              onSubmit={(e) => {
                const p: typeof problems = {};
                if (!amountPaise) p.amount = 'Enter the amount in rupees, for example 25000.';
                const fileInput = document.getElementById(field('file')) as HTMLInputElement | null;
                if (!proformaId && !(fileInput?.files && fileInput.files.length > 0)) p.file = 'Attach the supplier’s proforma or hold document.';
                // The note for Accounts is optional; when written it must be 10 to 500 characters.
                const len = reason.trim().length;
                if (len > 0 && (len < 10 || len > 500)) p.reason = 'Write 10 to 500 characters, or leave the note empty.';
                setProblems(p);
                const first = (['amount', 'file', 'reason'] as const).find((k) => p[k]);
                if (first) {
                  e.preventDefault();
                  document.getElementById(field(first))?.focus();
                }
              }}
            >
              <ResultLine state={state} />
              <Hidden
                fields={{
                  [SM_FIELD.taskId]: ctx.taskId,
                  [SM_FIELD.requestId]: requestId,
                  [SM_FIELD.expectedCostVersionNo]: ctx.costVersionNo ?? 0,
                  ...(resubmit ? { [SM_FIELD.paymentId]: resubmit.paymentId } : {}),
                  // Review F1: the database decides company funding itself; Purchase never asks for it.
                  [SM_FIELD.askFunding]: 'false',
                }}
              />
              <SummaryList aria-label="Agreed cost and requests so far">
                <SummaryRow label="Agreed supplier cost" numeric>
                  {ctx.agreedCostPaise ? formatPaise(ctx.agreedCostPaise) : 'No agreed cost yet'}
                </SummaryRow>
                <SummaryRow label="Already requested" numeric>
                  {formatPaise(ctx.requestedPaise)}
                </SummaryRow>
                <SummaryRow label="Left to request" numeric total>
                  {formatPaise(ctx.remainingPaise)}
                </SummaryRow>
              </SummaryList>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field htmlFor={field('part')} label="Part" hint={parts.length === 1 && parts[0] === 'deposit' ? 'Only a deposit can be asked before the supplier confirms.' : undefined}>
                  <Select id={field('part')} name={SM_FIELD.part} value={part} onChange={(e) => setPart(e.target.value as SupplierPaymentPart)} aria-describedby={parts.length === 1 ? `${field('part')}-hint` : undefined}>
                    {parts.map((p) => (
                      <option key={p} value={p}>
                        {PAYMENT_PART_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field htmlFor={field('amount')} label="Amount (₹)" error={problems.amount}>
                  <MoneyInput
                    id={field('amount')}
                    name={SM_FIELD.amountRupees}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    invalid={!!problems.amount}
                    aria-describedby={fieldDescribedBy(field('amount'), { error: problems.amount })}
                  />
                </Field>
                <Field htmlFor={field('due')} label="Due by" optional>
                  <Input id={field('due')} name={SM_FIELD.dueDate} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                </Field>
              </div>
              <Notice tone="info" role="status" title={ROUTE_LABEL[route]}>
                <p>{ROUTE_NOTICE[route]}</p>
                <p>
                  Already asked for this supplier on this Deal: <span className="tabular-nums">{formatPaise(ctx.routeRunningTotalPaise)}</span>.
                </p>
              </Notice>
              {proformaId ? (
                <Notice tone="success" role="status">
                  <p>Proforma uploaded. Press “Send payment request” again to finish.</p>
                </Notice>
              ) : (
                <Field htmlFor={field('file')} label="Supplier proforma or hold document" hint={SUPPLIER_MONEY_FILE_HINT} error={problems.file}>
                  <input
                    key={savedKey}
                    id={field('file')}
                    name={SM_FIELD.file}
                    type="file"
                    accept={ACCEPT}
                    aria-invalid={problems.file ? true : undefined}
                    aria-describedby={fieldDescribedBy(field('file'), { hint: true, error: problems.file })}
                    className="block w-full max-w-full text-base"
                  />
                </Field>
              )}
              <Field htmlFor={field('note')} label="Short description" optional hint="Shown with the request, for example “50% advance”.">
                <Textarea id={field('note')} name={SM_FIELD.note} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`${field('note')}-hint`} />
              </Field>
              <Field htmlFor={field('reason')} label={NOTE_FOR_ACCOUNTS.label} hint={NOTE_FOR_ACCOUNTS.hint} error={problems.reason}>
                <Textarea
                  id={field('reason')}
                  name={SM_FIELD.fundingReason}
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  invalid={!!problems.reason}
                  aria-describedby={fieldDescribedBy(field('reason'), { hint: true, error: problems.reason })}
                />
              </Field>
              <p className="m-0 text-sm text-quiet">Nothing is paid by sending this. Approval is not payment; Accounts pays and records it.</p>
              <div>
                <Submit label="Send payment request" pendingLabel="Sending…" />
              </div>
            </HandForm>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Supplier invoice or credit note (Files tab)
// ---------------------------------------------------------------------------

export function SupplierDocumentDrawer({
  taskId,
  action,
  uploadAction,
  triggerVariant = 'secondary',
  invoices = [],
  linkAction,
}: {
  taskId: string;
  action: DecisionAction;
  /** B's supplier-money file upload (kind invoice or credit_note): runs first and returns the evidence id. */
  uploadAction: DecisionAction;
  triggerVariant?: 'primary' | 'secondary';
  /**
   * Accounts phase (contract 6.2.2): invoices of this task (not returned) a credit note can be for.
   * The credit note form offers them as a choice ("creditsDocumentId"), so nothing is typed twice.
   */
  invoices?: Array<{ id: string; label: string }>;
  /**
   * Accounts phase (contract 7.3 S1): when the upload is refused as a duplicate and the database names the
   * existing bill, offer "Link the existing bill to this task" instead (nothing is typed again).
   */
  linkAction?: DecisionAction;
}) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SupplierDocumentKind>('invoice');
  const [gst, setGst] = useState(true);
  const [evidence, setEvidence] = useState<{ id: string; kind: SupplierDocumentKind } | null>(null);
  const [uploadRequestId, setUploadRequestId] = useState(() => crypto.randomUUID());
  const [state, run] = useActionState(async (prev: UiResult | null, fd: FormData): Promise<UiResult> => {
    let evidenceId = evidence && evidence.kind === kind ? evidence.id : null;
    if (!evidenceId) {
      const file = fd.get(SM_FIELD.file);
      if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'invalid_input', message: 'Choose the document file first.' };
      const up = new FormData();
      up.set(SM_FIELD.taskId, taskId);
      up.set(SM_FIELD.kind, kind);
      up.set(SM_FIELD.file, file);
      up.set(SM_FIELD.requestId, uploadRequestId);
      const uploaded = await guard(uploadAction)(prev as never, up);
      if (!uploaded.ok) return uploaded;
      evidenceId = (uploaded as { data?: { evidenceId?: string } }).data?.evidenceId ?? null;
      if (!evidenceId) return { ok: false, code: 'unexpected', message: SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT };
      setEvidence({ id: evidenceId, kind });
    }
    fd.delete(SM_FIELD.file);
    fd.set(SM_FIELD.evidenceId, evidenceId);
    const result = await guard(action)(prev as never, fd);
    if (result.ok) {
      setEvidence(null);
      setUploadRequestId(crypto.randomUUID());
    }
    return result;
  }, null);
  const requestId = useRequestId(state);
  const savedKey = useSavedKey(state && state.ok ? state : null);
  const f = (n: string) => `${base}-${n}`;
  const existingId = state && !state.ok ? ((state as { existingDocumentId?: unknown }).existingDocumentId as string | undefined) : undefined;
  const [linked, setLinked] = useState<UiResult | null>(null);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant={triggerVariant}>
          <Plus aria-hidden="true" />
          Upload invoice or credit note
        </Button>
      </DrawerTrigger>
      <DrawerContent className="w-[min(32rem,100vw)] max-sm:rounded-none" closeLabel="Close without uploading">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Upload a supplier invoice or credit note</DrawerTitle>
          <DrawerDescription className="m-0 text-sm text-quiet">Accounts checks it. Payments are not made from this upload.</DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          {linked?.ok ? (
            <div className="flex flex-col gap-3">
              <ResultLine state={linked} />
              <div>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          ) : state?.ok ? (
            <div className="flex flex-col gap-3">
              <ResultLine state={state} />
              <div>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <HandForm action={run} noValidate aria-label="Upload a supplier document" className="flex flex-col gap-4" encType="multipart/form-data">
              <ResultLine state={state} />
              {existingId && linkAction ? <LinkExistingBill documentId={existingId} taskId={taskId} action={linkAction} onDone={setLinked} /> : null}
              <Hidden fields={{ [SM_FIELD.taskId]: taskId, [SM_FIELD.requestId]: requestId, [SM_FIELD.gstIncluded]: gst ? 'true' : 'false' }} />
              <Field htmlFor={f('kind')} label="What is it?">
                <Select id={f('kind')} name={SM_FIELD.kind} value={kind} onChange={(e) => setKind(e.target.value as SupplierDocumentKind)}>
                  {(Object.keys(DOCUMENT_KIND_LABEL) as SupplierDocumentKind[]).map((k) => (
                    <option key={k} value={k}>
                      {DOCUMENT_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field htmlFor={f('number')} label={kind === 'invoice' ? 'Invoice number' : 'Credit note number'}>
                  <Input id={f('number')} name={SM_FIELD.number} maxLength={60} required autoComplete="off" />
                </Field>
                <Field htmlFor={f('date')} label="Date on the document">
                  <Input id={f('date')} name={SM_FIELD.docDate} type="date" required />
                </Field>
                <Field htmlFor={f('total')} label="Total (₹)">
                  <MoneyInput id={f('total')} name={SM_FIELD.totalRupees} required />
                </Field>
              </div>
              {kind === 'credit_note' && invoices.length > 0 ? (
                <Field htmlFor={f('credits')} label="Credit note for invoice" optional hint="Choose the invoice this credit note reduces. Accounts can add it later too.">
                  <Select id={f('credits')} name={SM_FIELD.creditsDocumentId} defaultValue="" aria-describedby={`${f('credits')}-hint`}>
                    <option value="">Not sure / not listed</option>
                    {invoices.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <label className="flex items-start gap-2 font-medium text-ink">
                <input type="checkbox" className="mt-1.5 size-4" checked={gst} onChange={(e) => setGst(e.target.checked)} />
                The total includes GST
              </label>
              {evidence && evidence.kind === kind ? (
                <Notice tone="success" role="status">
                  <p>File uploaded. Press “Upload document” again to finish.</p>
                </Notice>
              ) : (
                <Field htmlFor={f('file')} label="File" hint={SUPPLIER_MONEY_FILE_HINT}>
                  <input key={savedKey} id={f('file')} name={SM_FIELD.file} type="file" accept={ACCEPT} required aria-describedby={`${f('file')}-hint`} className="block w-full max-w-full text-base" />
                </Field>
              )}
              <div>
                <Submit label="Upload document" pendingLabel="Uploading…" />
              </div>
            </HandForm>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Trip cancellation: what the supplier keeps and refunds
// ---------------------------------------------------------------------------

export function CancellationChargeForm({
  taskId,
  expectedRevisionNo,
  committedCostPaise,
  defaults,
  action,
  uploadAction,
}: {
  taskId: string;
  /** 0 when no charge was entered yet. */
  expectedRevisionNo: number;
  committedCostPaise: string | null;
  defaults: { keepsPaise: string | null; refundPaise: string | null; note: string | null };
  action: DecisionAction;
  /** B's supplier-money upload (kind credit_note); optional credit note file. */
  uploadAction: DecisionAction;
}) {
  const base = useId();
  const [keeps, setKeeps] = useState(defaults.keepsPaise ? paiseToRupeesInput(defaults.keepsPaise) : '');
  const [refund, setRefund] = useState(defaults.refundPaise ? paiseToRupeesInput(defaults.refundPaise) : '');
  const [note, setNote] = useState(defaults.note ?? '');
  const [creditNoteId, setCreditNoteId] = useState<string | null>(null);
  const [uploadRequestId] = useState(() => crypto.randomUUID());
  const [state, run] = useActionState(async (prev: UiResult | null, fd: FormData): Promise<UiResult> => {
    let evidenceId = creditNoteId;
    const file = fd.get('file');
    if (!evidenceId && file instanceof File && file.size > 0) {
      const up = new FormData();
      up.set(SM_FIELD.taskId, taskId);
      up.set(SM_FIELD.kind, 'credit_note');
      up.set(SM_FIELD.file, file);
      up.set(SM_FIELD.requestId, uploadRequestId);
      const uploaded = await guard(uploadAction)(prev as never, up);
      if (!uploaded.ok) return uploaded;
      evidenceId = (uploaded as { data?: { evidenceId?: string } }).data?.evidenceId ?? null;
      if (evidenceId) setCreditNoteId(evidenceId);
    }
    fd.delete('file');
    if (evidenceId) fd.set('creditNoteEvidenceId', evidenceId);
    return guard(action)(prev as never, fd);
  }, null);
  const requestId = useRequestId(state);
  const keepsP = rupeesToPaise(keeps) ?? (keeps.trim() === '0' ? 0n : null);
  const refundP = rupeesToPaise(refund) ?? (refund.trim() === '0' ? 0n : null);
  let sumNote: string | null = null;
  if (committedCostPaise && keepsP !== null && refundP !== null) {
    const diff = BigInt(committedCostPaise) - (keepsP + refundP);
    if (diff !== 0n) sumNote = `Keeps plus refund is ${formatPaise((keepsP + refundP).toString())}; the agreed cost was ${formatPaise(committedCostPaise)}. Check the numbers or explain in the note.`;
  }
  return (
    <HandForm action={run} noValidate aria-label="Supplier cancellation charges" className="flex flex-col gap-3" encType="multipart/form-data">
      <ResultLine state={state} />
      <Hidden fields={{ taskId, expectedRevisionNo, requestId }} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field htmlFor={`${base}-keeps`} label="Supplier keeps (₹)" hint="Their cancellation charge.">
          <MoneyInput id={`${base}-keeps`} name="keepsRupees" value={keeps} onChange={(e) => setKeeps(e.target.value)} aria-describedby={`${base}-keeps-hint`} />
        </Field>
        <Field htmlFor={`${base}-refund`} label="Supplier refunds (₹)" hint="What comes back to the company.">
          <MoneyInput id={`${base}-refund`} name="refundRupees" value={refund} onChange={(e) => setRefund(e.target.value)} aria-describedby={`${base}-refund-hint`} />
        </Field>
      </div>
      {sumNote ? (
        <Notice tone="warning" role="status">
          <p>{sumNote}</p>
        </Notice>
      ) : null}
      <Field htmlFor={`${base}-note`} label="Note" optional>
        <Textarea id={`${base}-note`} name="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {creditNoteId ? (
        <p className="m-0 text-sm text-copy" role="status">
          Credit note uploaded.
        </p>
      ) : (
        <Field htmlFor={`${base}-file`} label="Supplier’s credit note" optional hint={SUPPLIER_MONEY_FILE_HINT}>
          <input id={`${base}-file`} name="file" type="file" accept={ACCEPT} aria-describedby={`${base}-file-hint`} className="block w-full max-w-full text-base" />
        </Field>
      )}
      <div>
        <Submit label={expectedRevisionNo > 0 ? 'Change charges' : 'Save charges'} pendingLabel="Saving…" variant="secondary" />
      </div>
    </HandForm>
  );
}

/** One press, no fields: "Send charges to the Manager", "Cancel request". */
export function OnePressForm({
  fields,
  action,
  label,
  pendingLabel,
  variant = 'secondary',
  formLabel,
}: {
  fields: Record<string, string | number>;
  action: DecisionAction;
  label: string;
  pendingLabel: string;
  variant?: 'primary' | 'secondary';
  formLabel: string;
}) {
  const [state, run] = useActionState((prev: UiResult | null, fd: FormData) => guard(action)(prev as never, fd), null);
  const requestId = useRequestId(state);
  return (
    <HandForm action={run} noValidate aria-label={formLabel} className="flex flex-col gap-2">
      <Hidden fields={{ ...fields, requestId }} />
      <div>
        <Submit label={label} pendingLabel={pendingLabel} variant={variant} />
      </div>
      {state ? <ResultLine state={state} /> : null}
    </HandForm>
  );
}

/**
 * Accounts phase (contract 7.3 S1, H11): the bill is already recorded (same supplier, number and financial
 * year), so link that bill to this task instead of uploading it again. The amount is not split.
 */
function LinkExistingBill({ documentId, taskId, action, onDone }: { documentId: string; taskId: string; action: DecisionAction; onDone: (r: UiResult) => void }) {
  const [state, run] = useActionState(async (_prev: UiResult | null, fd: FormData): Promise<UiResult> => {
    const r = await guard(action)(null as never, fd);
    if (r.ok) onDone(r);
    return r;
  }, null);
  const requestId = useRequestId(state);
  return (
    <div className="flex flex-col items-start gap-2 rounded-control border border-line bg-canvas px-3.5 py-3">
      <p className="m-0 text-sm text-copy">The same bill can count for this task too. Nothing is paid and the amount is not split.</p>
      {state && !state.ok ? <ResultLine state={state} /> : null}
      <HandForm action={run} aria-label="Link the existing bill to this task">
        <Hidden fields={{ documentId, taskId, requestId }} />
        <Submit label="Link the existing bill to this task" pendingLabel="Linking…" variant="secondary" />
      </HandForm>
    </div>
  );
}
