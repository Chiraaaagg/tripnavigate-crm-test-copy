import { FileText, Printer, Download, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { CommandButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr, whenText } from '@/views/accounts-desk/labels';
import { autoStateWords, crmHistoryLine, RELEASED_BY_CRM_LINE, documentStatusLines, expectedNumber, holdFix, holdReasonWords, KIND_TITLE, madeByLine, PDF_STATE_WORDS, rowTone, warningText, type HoldFixLinks } from './labels';
import type { AutoBillSwitches, DealDocs, DocRow, TallyInvoiceOption } from './types';

/*
 * Deal page "Customer documents" card (Accounts phase 2 contract 6.3–6.8,
 * 6.9 R-B1, screen 11.1). Accounts see what is ready to make (one Advance
 * Invoice per verified payment, the Invoice once the booking is approved,
 * credit notes from refunds), drafts with the full preview and "Release as
 * …?", and released documents with their actions. The branch Manager and the
 * Sales owner see released, replaced and cancelled documents only, with the
 * PDF download or the print view. Purchase, Flight and Visa get null from
 * the database and the route renders nothing.
 *
 * A Server Component: draft previews are track B's template rendered on the
 * server and passed in (no zod reaches the browser); the buttons and dialogs
 * are client islands from the Accounts phase 2 kit.
 *
 * Accounts phase 3 (contract 6.2–6.5, screen 5): drafts the CRM made say
 * "Made by the CRM" with the rule in words; a held automatic draft lists
 * every reason with its repair link; a document the CRM released says so.
 * "Release" stays on every draft (automatic release Off: ready drafts wait
 * here). Without the new keys the card renders exactly as in Phase 2.
 */

export interface DocActions {
  createDraft: DecisionAction;
  refresh: DecisionAction;
  release: DecisionAction;
  discard: DecisionAction;
  cancel: DecisionAction;
  replace: DecisionAction;
  linkTally: DecisionAction;
  retryPdf: DecisionAction;
}

type DialogKind = 'release' | 'discard' | 'cancel' | 'replace' | 'link';

export interface DocCardPreview {
  /** Open one dialog of one document (preview gallery). */
  open?: { documentId: string; dialog: DialogKind; state?: DeskResult | null };
}

export function DealCustomerDocumentsCard({
  docs,
  dealId,
  actions,
  previews,
  tallyInvoices = [],
  numberPrefix = null,
  billingHref,
  reviewHref,
  preview,
}: {
  docs: DealDocs | 'error';
  dealId: string;
  /** Accounts only. */
  actions?: DocActions | null;
  /** Draft previews (template rendered on the server), by document id. */
  previews?: Record<string, ReactNode>;
  /** Active Tally GST invoice references of the Deal, for "Link GST invoice number". */
  tallyInvoices?: TallyInvoiceOption[];
  /** Bitrix Deal ID, else the CRM Deal reference (contract 6.3), for the expected number line. */
  numberPrefix?: string | null;
  /** Where Accounts verify the billing details. */
  billingHref?: string;
  /** Accounts phase 3: the Accounts review of this Deal (repair link for "newer version waiting"). */
  reviewHref?: string;
  preview?: DocCardPreview;
}) {
  if (docs === 'error') {
    return (
      <Card id="customer-documents">
        <section aria-labelledby="cdoc-heading">
          <CardHeader>
            <CardTitle id="cdoc-heading">Customer documents</CardTitle>
          </CardHeader>
          <CardBody>
            <Notice tone="warning" role="status">
              <p>The customer documents could not be loaded just now. Nothing was changed. Reload the page.</p>
            </Notice>
          </CardBody>
        </section>
      </Card>
    );
  }
  const accounts = docs.viewer === 'accounts' && !!actions;
  const drafts = docs.documents.filter((d) => d.status === 'draft');
  const issued = docs.documents.filter((d) => d.status === 'released' || d.status === 'replaced' || d.status === 'cancelled');
  const c = accounts ? docs.candidates : null;
  const candidateCount = c ? c.advances.length + (c.invoice ? 1 : 0) + c.creditNotes.length : 0;
  const offBlock = docs.enabled ? null : 'Customer documents are not switched on yet.';
  const held = accounts ? drafts.filter((d) => d.autoState === 'held').length : 0;
  const fixLinks: HoldFixLinks = { billingHref: billingHref ?? null, reviewHref: reviewHref ?? null };
  const summary = [
    issued.length ? `${issued.length} issued` : null,
    accounts && drafts.length ? `${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'}` : null,
    held ? `${held} held` : null,
    accounts && candidateCount ? `${candidateCount} ready to make` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card id="customer-documents">
      <section aria-labelledby="cdoc-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="cdoc-heading">Customer documents</CardTitle>
            <CardDescription>{summary || 'Advance Invoices, Invoice and Credit Notes for this Deal.'}</CardDescription>
          </div>
          <FileText aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {!docs.enabled ? (
            <Notice tone="info" title="Customer documents are not switched on yet">
              <p>{accounts ? 'Drafts can be made once a Super Admin switches customer documents on in Settings · Accounts. Nothing is released before then.' : 'Released documents will show here once Accounts start issuing them.'}</p>
            </Notice>
          ) : null}
          {accounts && docs.enabled && docs.autoBills ? <AutoBillsLine auto={docs.autoBills} /> : null}
          {accounts && (docs.billing.missing || !docs.billing.verified) ? (
            <Notice tone="warning" title={docs.billing.missing ? 'Billing details missing' : 'Billing details not verified'}>
              <p>Documents can be drafted, but nothing can be released until the billing details for this Deal are verified.</p>
              {billingHref ? (
                <p className="m-0 mt-[0.25rem]">
                  <Link href={billingHref} className="font-semibold text-brand-strong underline underline-offset-4">
                    Open billing details
                  </Link>
                </p>
              ) : null}
            </Notice>
          ) : null}

          {accounts ? (
            <Candidates dealId={dealId} c={c} actions={actions!} offBlock={offBlock} hasLiveInvoiceDraft={drafts.some((d) => d.kind === 'invoice')} />
          ) : null}

          {accounts && drafts.length > 0 ? (
            <section aria-labelledby="cdoc-drafts" className="flex flex-col gap-3">
              <h3 id="cdoc-drafts" className="m-0 text-base font-semibold text-ink">
                Drafts
              </h3>
              {drafts.map((d) => (
                <DraftBlock
                  key={d.documentId}
                  d={d}
                  docs={docs}
                  dealId={dealId}
                  actions={actions!}
                  preview={previews?.[d.documentId]}
                  tallyInvoices={tallyInvoices}
                  numberPrefix={numberPrefix}
                  offBlock={offBlock}
                  autoBills={docs.autoBills ?? null}
                  fixLinks={fixLinks}
                  open={preview?.open?.documentId === d.documentId ? preview.open : undefined}
                />
              ))}
            </section>
          ) : null}

          <section aria-labelledby="cdoc-issued" className="flex flex-col gap-3">
            <h3 id="cdoc-issued" className="m-0 text-base font-semibold text-ink">
              Issued documents
            </h3>
            {issued.length === 0 ? (
              <p className="m-0 text-copy">
                {accounts ? 'Nothing released yet. Release a draft above to give it its number.' : 'No documents released for this Deal yet. Accounts issue them after payments are verified and the booking is approved.'}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {issued.map((d) => (
                  <IssuedRow
                    key={d.documentId}
                    d={d}
                    dealId={dealId}
                    accounts={accounts}
                    actions={actions ?? null}
                    tallyInvoices={tallyInvoices}
                    offBlock={offBlock}
                    open={preview?.open?.documentId === d.documentId ? preview.open : undefined}
                  />
                ))}
              </ul>
            )}
          </section>
        </CardBody>
      </section>
    </Card>
  );
}

/** Accounts phase 3: how automatic bills behave for this company right now (one line, words not colour). */
function AutoBillsLine({ auto }: { auto: AutoBillSwitches }) {
  if (!auto.drafts) return null;
  return (
    <Notice tone="info" title="Automatic bills are on">
      <p>
        {auto.release
          ? 'The CRM makes each draft when a payment is verified, the booking is approved or a refund is settled, checks it, and releases it by itself when every check passes. A held draft waits below with the reason.'
          : 'The CRM makes each draft when a payment is verified, the booking is approved or a refund is settled, and checks it. Automatic release is off, so drafts that pass the checks wait here for you to release them.'}{' '}
        Nothing is sent to the customer.
      </p>
    </Notice>
  );
}

function Candidates({ dealId, c, actions, offBlock, hasLiveInvoiceDraft }: { dealId: string; c: DealDocs['candidates']; actions: DocActions; offBlock: string | null; hasLiveInvoiceDraft: boolean }) {
  const items: ReactNode[] = [];
  for (const a of c?.advances ?? []) {
    items.push(
      <li key={`adv-${a.receiptId}`} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-canvas px-3 py-2.5">
        <p className="m-0 min-w-0 text-copy">
          <span className="font-semibold text-ink">Advance received {dayText(a.receivedOn)}</span>
          <span className="text-quiet"> — {a.receiptNo} — </span>
          <span className="font-semibold whitespace-nowrap tabular-nums text-ink">{inr(a.amountPaise)}</span>
        </p>
        <CommandButton action={actions.createDraft} fields={{ dealId, kind: 'advance_invoice', receiptId: a.receiptId }} ariaLabel={`Create draft Advance Invoice for ${a.receiptNo}`} label="Create draft" pendingLabel="Making the draft…" blockedReason={offBlock} okTitle="Draft made" />
      </li>,
    );
  }
  if (c?.invoice) {
    const inv = c.invoice;
    items.push(
      <li key="inv" className="flex flex-col gap-2 rounded-control border border-line bg-canvas px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 min-w-0 text-copy">
            <span className="font-semibold text-ink">Invoice{inv.basisVersionNo ? ` from approved booking version ${inv.basisVersionNo}` : ''}</span>
            <span className="text-quiet"> — </span>
            <span className="font-semibold whitespace-nowrap tabular-nums text-ink">{inr(inv.totalPaise)}</span>
          </p>
          <CommandButton
            action={actions.createDraft}
            fields={{ dealId, kind: 'invoice' }}
            ariaLabel="Create draft Invoice"
            label="Create draft"
            pendingLabel="Making the draft…"
            blockedReason={offBlock ?? (hasLiveInvoiceDraft ? 'An Invoice draft is already open below.' : null)}
            okTitle="Draft made"
          />
        </div>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {inv.lines.map((l, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-x-3">
              <span className="min-w-0 wrap-anywhere">{l.label}</span>
              <span className="whitespace-nowrap tabular-nums">{inr(l.amountPaise)}</span>
            </li>
          ))}
        </ul>
        {inv.warnings.map((w) => (
          <p key={w} className="m-0 text-sm text-ink">
            <span className="font-semibold">Check: </span>
            {warningText(w)}
          </p>
        ))}
      </li>,
    );
  }
  for (const n of c?.creditNotes ?? []) {
    items.push(
      <li key={`cn-${n.refundRequestId}`} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-canvas px-3 py-2.5">
        <p className="m-0 min-w-0 text-copy">
          <span className="font-semibold text-ink">Credit Note{n.refNo ? ` for refund ${n.refNo}` : ''}</span>
          <span className="text-quiet"> — </span>
          <span className="font-semibold whitespace-nowrap tabular-nums text-ink">{inr(n.amountPaise)}</span>
        </p>
        <CommandButton action={actions.createDraft} fields={{ dealId, kind: 'credit_note', refundRequestId: n.refundRequestId }} ariaLabel={`Create draft Credit Note${n.refNo ? ` for refund ${n.refNo}` : ''}`} label="Create draft" pendingLabel="Making the draft…" blockedReason={offBlock} okTitle="Draft made" />
      </li>,
    );
  }
  return (
    <section aria-labelledby="cdoc-ready" className="flex flex-col gap-2">
      <h3 id="cdoc-ready" className="m-0 text-base font-semibold text-ink">
        Ready to make
      </h3>
      {items.length === 0 ? (
        <p className="m-0 text-copy">Nothing new to make. An Advance Invoice appears here when a payment is verified, the Invoice when Accounts approve the booking, and a Credit Note after an approved refund or settlement.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">{items}</ul>
      )}
    </section>
  );
}

function DraftBlock({
  d,
  docs,
  dealId,
  actions,
  preview,
  tallyInvoices,
  numberPrefix,
  offBlock,
  autoBills = null,
  fixLinks = {},
  open,
}: {
  d: DocRow;
  docs: DealDocs;
  dealId: string;
  actions: DocActions;
  preview: ReactNode;
  tallyInvoices: TallyInvoiceOption[];
  numberPrefix: string | null;
  offBlock: string | null;
  autoBills?: AutoBillSwitches | null;
  fixLinks?: HoldFixLinks;
  open?: DocCardPreview['open'];
}) {
  const made = madeByLine(d);
  const autoWords = autoStateWords(d);
  const title = KIND_TITLE[d.kind];
  const next = expectedNumber(d, docs.documents, numberPrefix);
  const releaseBlock = offBlock ?? (d.stale ? 'Refresh the draft first: the booking or money changed.' : !docs.billing.verified ? 'Verify the billing details first.' : !d.can.release ? 'Not available to you.' : null);
  const base = { documentId: d.documentId, expectedRowVersion: d.rowVersion };
  return (
    <article aria-labelledby={`draft-${d.documentId}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`draft-${d.documentId}`} className="m-0 text-base font-semibold text-ink">
          {title} draft{d.replacesNumber ? ` (replaces ${d.replacesNumber})` : ''}
        </h4>
        <StatusBadge tone={rowTone(d)} wrap>
          <span className="sr-only">Status: </span>
          {documentStatusLines(d)[0]}
        </StatusBadge>
        {autoWords ? (
          <StatusBadge tone={d.autoState === 'held' ? 'warning' : 'success'} wrap>
            <span className="sr-only">Automatic checks: </span>
            {autoWords}
          </StatusBadge>
        ) : null}
        <span className="ml-auto font-semibold whitespace-nowrap tabular-nums text-ink">{inr(d.totalPaise)}</span>
      </div>
      {made ? <p className="m-0 text-sm text-copy">{made}.</p> : null}
      {d.autoState === 'held' ? <HeldReasons d={d} links={fixLinks} /> : null}
      {d.autoState === 'ready' && d.autoRule ? (
        <p className="m-0 text-sm text-copy">
          {autoBills?.release
            ? 'Every check passed. The CRM releases it within a few minutes, or you can release it now.'
            : 'Every check passed. Automatic release is off, so release it yourself when you have looked at it.'}
        </p>
      ) : null}
      {d.stale ? (
        <Notice tone="warning" title="The booking or money changed since this draft was made">
          <p>Refresh the draft to rebuild it from the latest approved booking and verified money. It cannot be released until then.</p>
        </Notice>
      ) : null}
      {d.warnings.map((w) => (
        <Notice key={w} tone="warning">
          <p>{warningText(w)} You can still release it.</p>
        </Notice>
      ))}
      {d.gstInvoiceNumber ? <p className="m-0 text-sm text-copy">Tally GST invoice number: <span className="font-semibold text-ink">{d.gstInvoiceNumber}</span></p> : null}
      {preview ? (
        <details className="rounded-control border border-line bg-card" open>
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-ink">Preview of the {title}</summary>
          <div className="overflow-x-auto border-t border-line p-3" role="region" aria-label={`Preview of the ${title} draft`} tabIndex={0}>
            {preview}
          </div>
        </details>
      ) : (
        <p className="m-0 text-sm text-quiet">The preview did not load. Reload the page before releasing.</p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <DialogAction
          buttonLabel={next ? `Release as ${next}` : `Release this ${title}`}
          buttonVariant="primary"
          blockedReason={releaseBlock ?? (preview ? null : 'Reload the page: the preview did not load.')}
          title={next ? `Release as ${next}?` : `Release this ${title}?`}
          description={
            <>
              Releasing freezes exactly what the preview shows and gives it the next {title} number for this Deal{next ? ` (expected ${next}; the confirmation shows the number given)` : ''}. A released document cannot be edited; a mistake is fixed by a replacement or a cancellation with a reason.
            </>
          }
          primaryLabel={next ? `Release as ${next}` : 'Release'}
          pendingLabel="Releasing…"
          action={actions.release}
          fields={{ ...base, expectedContentSha256: d.contentSha256, dealId }}
          okTitle="Released"
          initialOpen={open?.dialog === 'release'}
          initialState={open?.dialog === 'release' ? open.state : undefined}
        />
        {d.stale ? (
          <CommandButton action={actions.refresh} fields={{ ...base, dealId }} label="Refresh the draft" pendingLabel="Refreshing…" blockedReason={offBlock ?? (d.can.refresh ? null : 'Not available to you.')} okTitle="Refreshed" />
        ) : null}
        {d.kind !== 'advance_invoice' ? (
          <LinkTally d={d} actions={actions} tallyInvoices={tallyInvoices} offBlock={offBlock} open={open?.dialog === 'link' ? open : undefined} />
        ) : null}
        <DialogAction
          buttonLabel="Discard draft"
          ariaLabel={`Discard draft ${title}`}
          buttonVariant="ghost"
          blockedReason={offBlock ?? (d.can.discard ? null : 'Not available to you.')}
          title={`Discard this ${title} draft?`}
          description="The draft is kept in the history as discarded. It never had a number, so no number is lost."
          primaryLabel="Discard draft"
          pendingLabel="Discarding…"
          danger
          cancelLabel="Keep the draft"
          action={actions.discard}
          fields={base}
          okTitle="Discarded"
          initialOpen={open?.dialog === 'discard'}
          initialState={open?.dialog === 'discard' ? open.state : undefined}
        >
          <ReasonField id={`discard-${d.documentId}`} />
        </DialogAction>
      </div>
      <p className="m-0 text-sm text-quiet">Made {whenText(d.createdAt)}.</p>
    </article>
  );
}

/** Accounts phase 3: every reason a draft is held, each with its repair link when one exists. */
function HeldReasons({ d, links }: { d: DocRow; links: HoldFixLinks }) {
  const reasons = d.holdReasons ?? [];
  return (
    <Notice tone="warning" title="Held — the CRM did not release this draft">
      {reasons.length === 0 ? (
        <p>A check did not pass. Refresh the draft or release it yourself after checking.</p>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          {reasons.map((code) => {
            const fix = holdFix(code, links);
            return (
              <li key={code} className="m-0">
                {holdReasonWords(code)}
                {fix ? (
                  <>
                    {' '}
                    <Link href={fix.href} className="font-semibold text-brand-strong underline underline-offset-4">
                      {fix.label}
                    </Link>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 mt-[0.25rem]">Once it is fixed, the CRM checks again by itself within a few minutes.</p>
    </Notice>
  );
}

function LinkTally({ d, actions, tallyInvoices, offBlock, open }: { d: DocRow; actions: DocActions; tallyInvoices: TallyInvoiceOption[]; offBlock: string | null; open?: DocCardPreview['open'] }) {
  const released = d.status !== 'draft';
  const label = d.gstInvoiceNumber ? (released ? 'GST invoice number linked' : 'Change GST invoice number') : 'Link GST invoice number';
  const block =
    offBlock ??
    (released && d.gstInvoiceNumber
      ? 'Already linked. A released document keeps its link.'
      : !d.can.linkTally
        ? 'Not available to you.'
        : tallyInvoices.length === 0
          ? 'Add the Tally GST invoice reference on the Customer dues card first.'
          : null);
  return (
    <DialogAction
      buttonLabel={label}
      ariaLabel={`${label} for ${KIND_TITLE[d.kind]}${d.number ? ` ${d.number}` : ' draft'}`}
      blockedReason={block}
      title="Link the Tally GST invoice number"
      description={released ? 'The number is shown in the CRM for this released document. The printed copy does not change; a replacement prints it.' : 'The draft is rebuilt with the number and prints it.'}
      primaryLabel="Link the number"
      pendingLabel="Linking…"
      action={actions.linkTally}
      fields={{ documentId: d.documentId, expectedRowVersion: d.rowVersion }}
      okTitle="Linked"
      initialOpen={!!open}
      initialState={open?.state}
    >
      {(
        <Field htmlFor={`tally-${d.documentId}`} label="Tally GST invoice reference" hint="The references Accounts recorded for this Deal.">
          <Select id={`tally-${d.documentId}`} name="tallyInvoiceId" required defaultValue="" aria-describedby={`tally-${d.documentId}-hint`}>
            <option value="" disabled>
              Choose a reference
            </option>
            {tallyInvoices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.invoiceRef} · {dayText(t.invoiceDate)}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </DialogAction>
  );
}

function IssuedRow({
  d,
  dealId,
  accounts,
  actions,
  tallyInvoices,
  offBlock,
  open,
}: {
  d: DocRow;
  dealId: string;
  accounts: boolean;
  actions: DocActions | null;
  tallyInvoices: TallyInvoiceOption[];
  offBlock: string | null;
  open?: DocCardPreview['open'];
}) {
  const lines = documentStatusLines(d);
  const title = KIND_TITLE[d.kind];
  const name = `${title} ${d.number ?? ''}`.trim();
  return (
    <li className="m-0 flex flex-col gap-2 rounded-control border border-line bg-canvas px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold wrap-anywhere text-ink">{d.number ?? 'No number'}</span>
        <span className="text-copy">{title}</span>
        <StatusBadge tone={rowTone(d)} wrap>
          <span className="sr-only">Status: </span>
          {lines[0]}
        </StatusBadge>
        {lines.slice(1).map((l) => (
          <StatusBadge key={l} tone="warning" wrap>
            {l}
          </StatusBadge>
        ))}
        <span className="ml-auto font-semibold whitespace-nowrap tabular-nums text-ink">{inr(d.totalPaise)}</span>
      </div>
      <p className="m-0 text-sm text-quiet">
        {d.issueDate ? `Issued ${dayText(d.issueDate)}` : 'Issued'}
        {d.releasedByCrm ? ` ${RELEASED_BY_CRM_LINE}` : d.releasedByName ? ` by ${d.releasedByName}` : ''}
        {d.autoRule ? ` · drafted ${crmHistoryLine(d.autoRule)}` : ''}
        {d.replacesNumber ? ` · replaces ${d.replacesNumber}` : ''}
        {d.gstInvoiceNumber ? ` · Tally GST invoice ${d.gstInvoiceNumber}` : ''}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <PdfControl d={d} dealId={dealId} name={name} retry={accounts ? (actions?.retryPdf ?? null) : null} />
        {accounts && actions && d.status === 'released' ? (
          <>
            {d.kind !== 'advance_invoice' && !d.gstInvoiceNumber ? <LinkTally d={d} actions={actions} tallyInvoices={tallyInvoices} offBlock={offBlock} open={open?.dialog === 'link' ? open : undefined} /> : null}
            {d.kind !== 'credit_note' ? (
              <DialogAction
                buttonLabel="Replace"
                ariaLabel={`Replace ${name}`}
                blockedReason={offBlock ?? (d.can.replace ? null : 'A replacement is already in progress, or this is not available to you.')}
                title={`Replace ${name}?`}
                description={`A new draft is made from today's booking and money. ${d.number ?? 'This document'} stays released until the replacement is released, then shows "Replaced by" the new number.`}
                primaryLabel="Make the replacement draft"
                pendingLabel="Making the draft…"
                action={actions.replace}
                fields={{ documentId: d.documentId, expectedRowVersion: d.rowVersion }}
                okTitle="Replacement draft made"
                initialOpen={open?.dialog === 'replace'}
                initialState={open?.dialog === 'replace' ? open.state : undefined}
              >
                <ReasonField id={`replace-${d.documentId}`} label="Why it is replaced" />
              </DialogAction>
            ) : null}
            <DialogAction
              buttonLabel="Cancel document"
              ariaLabel={`Cancel document ${name}`}
              buttonVariant="ghost"
              blockedReason={offBlock ?? (d.can.cancel ? null : 'A released credit note refers to it, or this is not available to you.')}
              title={`Cancel ${name}?`}
              description="The document stays in the history as cancelled, with your reason. Its number is not used again."
              primaryLabel="Cancel the document"
              pendingLabel="Cancelling…"
              danger
              cancelLabel="Keep it"
              action={actions.cancel}
              fields={{ documentId: d.documentId, expectedRowVersion: d.rowVersion }}
              okTitle="Cancelled"
              initialOpen={open?.dialog === 'cancel'}
              initialState={open?.dialog === 'cancel' ? open.state : undefined}
            >
              <ReasonField id={`cancel-${d.documentId}`} label="Why it is cancelled" />
            </DialogAction>
          </>
        ) : null}
      </div>
    </li>
  );
}

function PdfControl({ d, dealId, name, retry }: { d: DocRow; dealId: string; name: string; retry: DecisionAction | null }) {
  const printHref = `/app/deals/${dealId}/documents/${d.documentId}`;
  const printLink = d.can.printView ? (
    <Link href={printHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })} aria-label={`Print view of ${name}`}>
      <Printer aria-hidden="true" />
      Print view
    </Link>
  ) : null;
  switch (d.screenPdf) {
    case 'ready':
      return d.can.download ? (
        <a href={`/app/deals/${dealId}/documents/${d.documentId}/pdf`} className={buttonVariants({ variant: 'secondary', size: 'sm' })} aria-label={`Download PDF of ${name}`}>
          <Download aria-hidden="true" />
          Download PDF
        </a>
      ) : (
        printLink
      );
    case 'failed':
      return (
        <span className="inline-flex flex-wrap items-start gap-2">
          <span className="self-center text-sm text-status-danger-strong">{retry ? 'PDF failed.' : 'PDF failed — Accounts can make it again.'}</span>
          {retry ? <CommandButton action={retry} fields={{ documentId: d.documentId, dealId }} label="Make the PDF again" pendingLabel="Asking…" okTitle="Asked" blockedReason={d.can.retryPdf ? null : 'Not available to you.'} /> : null}
          {printLink}
        </span>
      );
    case 'queued':
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-sm text-quiet">
            <RefreshCw aria-hidden="true" className="size-3.5" />
            {PDF_STATE_WORDS.queued}
          </span>
          {printLink}
        </span>
      );
    default:
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="text-sm text-quiet">PDF not made yet</span>
          {printLink}
        </span>
      );
  }
}
