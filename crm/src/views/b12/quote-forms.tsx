'use client';

import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { startTransition, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { cn, focusRing } from '@/components/ui/cn';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  DECLINE_REASON_LABEL,
  DECLINE_REASONS,
  QUOTATION_EVIDENCE_KIND_LABEL,
  QUOTATION_EVIDENCE_MAX_BYTES,
  QUOTATION_TEXT,
  SENT_CHANNEL_LABEL,
  SENT_CHANNELS,
  type QuotationConversionResult,
  type QuotationCreateResult,
  type QuotationNewVersionResult,
} from '@/modules/quotations/contracts';
import { QFIELD } from '@/modules/quotations/forms';
import { dateText } from '../b11/book-fields';
import { SelectField, TextField } from '../b11/controls';
import { newRequestId, PendingButton } from '../b11/form-kit';
import { inr0, TIER_LABEL } from './quote-fields';
import { useQuoteAction, QuoteResultBox, quoteProblem, type QuoteAction } from './quote-kit';
import { bookingHref, quotationHref, type QuoteLinkCandidate, type QuoteVersionView } from './quote-shapes';

/*
 * The quotation state forms (B1.2 Phase E): create, mark sent, the written
 * acceptance (upload, accept with the chosen option), decline, new version,
 * link the Deal from Bitrix and "Start booking from this quotation". Each is
 * a small form that works before script loads; typed values stay after a
 * refusal; one request id per attempt makes a repeat press safe.
 */

const textLink = cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing);
const BOOK_SAVED_FLAG = 'tn-b11-saved';

function rememberForNextPage(text: string) {
  try {
    sessionStorage.setItem(BOOK_SAVED_FLAG, text);
  } catch {
    // Storage blocked: the next page simply does not announce it.
  }
}

// ---------------------------------------------------------------------------
// Create quotation (Lead and Deal pages)
// ---------------------------------------------------------------------------

export function CreateQuotationForm({
  subjectKind,
  subjectId,
  defaultTitle,
  action,
  variant = 'primary',
}: {
  /** Batch 3: 'referral' adds a quotation to an existing referral draft (the database decides). */
  subjectKind: 'lead' | 'deal' | 'referral';
  subjectId: string;
  defaultTitle: string;
  action: QuoteAction;
  /** Batch 1 (copy §16.3): 'secondary' where the page header already has the one primary action (Deal Quotations tab). */
  variant?: 'primary' | 'secondary';
}) {
  const [requestId] = useState(() => newRequestId());
  const [title, setTitle] = useState(defaultTitle.slice(0, 200));
  const [state, formAction] = useQuoteAction(action, {
    goTo: (data) => {
      const d = data as QuotationCreateResult | null;
      return d ? quotationHref(d.versionId) : null;
    },
  });
  return (
    <form action={formAction} noValidate className="flex w-full flex-col gap-3">
      <QuoteResultBox result={state} fields={[{ field: QFIELD.title, id: 'quote-create-title', label: 'Quotation title: 1 to 200 characters' }]} successText={QUOTATION_TEXT.created} />
      <input type="hidden" name={QFIELD.subjectKind} value={subjectKind} />
      <input type="hidden" name={QFIELD.subjectId} value={subjectId} />
      <input type="hidden" name={QFIELD.requestId} value={requestId} />
      <TextField
        id="quote-create-title"
        name={QFIELD.title}
        label="Quotation title"
        hint="Shown at the top of the quotation. You cannot change it later."
        value={title}
        onChange={setTitle}
        maxLength={200}
        error={quoteProblem(state, QFIELD.title, 'Type a title of 1 to 200 characters.')}
      />
      <div>
        <PendingButton pendingLabel="Creating…" variant={variant}>
          Create quotation
        </PendingButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Mark sent (ready versions)
// ---------------------------------------------------------------------------

/**
 * "Mark as shared" (QS-01, QU-02 P-DIALOG): the header's primary for a ready
 * version opens a dialog that says the CRM sends nothing, asks how it was
 * shared (the channel is still recorded) and confirms with "Mark as shared"
 * (one verb for one action, DA-188).
 * A refusal keeps the dialog open with the reason and the chosen channel.
 */
/** DA-188 (QS-03): the line after marking it shared. */
const MARKED_SHARED_TEXT = 'Marked as shared. To change anything, make a new version.';

export function MarkSentForm({ version: v, action }: { version: QuoteVersionView; action: QuoteAction }) {
  const [requestId] = useState(() => newRequestId());
  const [channel, setChannel] = useState('');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useQuoteAction(action, { onSuccess: () => setOpen(false) });
  const channels = [{ value: '', label: 'Choose how you shared it' }, ...SENT_CHANNELS.map((c) => ({ value: c, label: SENT_CHANNEL_LABEL[c] }))];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="lg" className="min-h-11">
          Mark as shared
        </Button>
      </DialogTrigger>
      {state && state.ok ? (
        <p role="status" className="m-0 basis-full text-sm text-copy">
          {MARKED_SHARED_TEXT}
        </p>
      ) : null}
      <DialogContent closeLabel="Close without marking it shared">
        <form
          noValidate
          aria-label="Mark as shared"
          onSubmit={(e) => {
            // Posted by hand (not the form action) so React does not reset the form: the chosen channel stays after a refusal.
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            startTransition(() => formAction(fd));
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark version {v.versionNo} as shared?</DialogTitle>
            <DialogDescription>The CRM does not send anything. You share it with the customer yourself.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <QuoteResultBox result={state} fields={[{ field: QFIELD.channel, id: 'quote-sent-channel', label: 'How you shared it' }]} />
            <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
            <input type="hidden" name={QFIELD.contentHash} value={v.contentHash ?? ''} />
            <input type="hidden" name={QFIELD.requestId} value={requestId} />
            <SelectField
              id="quote-sent-channel"
              name={QFIELD.channel}
              label="How did you share it?"
              value={channel}
              onChange={setChannel}
              options={channels}
              error={quoteProblem(state, QFIELD.channel, 'Choose how you shared the quotation.')}
            />
            <p className="m-0 text-sm text-quiet">
              {v.validUntil ? `Valid until ${dateText(v.validUntil)}.` : 'Valid for 7 days after the quotation was made.'} After this, this version cannot change and replaces the one shared before.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
              Go back
            </Button>
            <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending} className="min-h-11">
              {pending ? 'Marking…' : 'Mark as shared'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Written acceptance: files, accept, decline (sent versions)
// ---------------------------------------------------------------------------

export function EvidenceList({ version: v, removeAction }: { version: QuoteVersionView; removeAction?: QuoteAction }) {
  if (v.evidence.length === 0) return <p className="m-0 text-copy">No file uploaded yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Files of this version">
      {v.evidence.map((e) => (
        <li key={e.evidenceId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-2.5">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
          <span className="min-w-40 flex-1">
            <span className="block font-medium wrap-anywhere text-ink">{e.fileName}</span>
            <span className="block text-sm text-quiet">
              {QUOTATION_EVIDENCE_KIND_LABEL[e.kind]} · {e.sizeLabel} · {e.status === 'stored' ? `stored ${dateText(e.storedAt ?? e.uploadedAt)}` : e.status === 'failed' ? 'not stored: upload it again' : 'upload not finished'}
            </span>
          </span>
          {e.downloadHref && e.status === 'stored' ? (
            <a href={e.downloadHref} className={cn(textLink, 'inline-flex min-h-11 items-center gap-1')}>
              <Download aria-hidden="true" className="size-4" />
              Open<span className="sr-only"> {e.fileName}</span>
            </a>
          ) : null}
          {removeAction && e.uploadedByYou && v.status === 'sent' ? <RemoveEvidenceForm versionId={v.versionId} evidenceId={e.evidenceId} fileName={e.fileName} action={removeAction} /> : null}
        </li>
      ))}
    </ul>
  );
}

function RemoveEvidenceForm({ versionId, evidenceId, fileName, action }: { versionId: string; evidenceId: string; fileName: string; action: QuoteAction }) {
  const [state, formAction] = useQuoteAction(action);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <QuoteResultBox result={state && !state.ok ? state : null} />
      <input type="hidden" name={QFIELD.versionId} value={versionId} />
      <input type="hidden" name={QFIELD.evidenceId} value={evidenceId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="min-h-11"
        onClick={(e) => {
          if (!window.confirm(`Remove ${fileName} from this version?`)) e.preventDefault();
        }}
      >
        <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {fileName}</span>
      </Button>
    </form>
  );
}

const EVIDENCE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** Plain words for a file the server would refuse; null when it may be sent. */
export function evidenceFileProblem(file: { size: number; type: string; name: string }): string | null {
  if (!EVIDENCE_TYPES.includes(file.type)) return `${file.name} is not a PDF, JPG, PNG or WebP file. Choose another file; nothing was uploaded.`;
  if (file.size > QUOTATION_EVIDENCE_MAX_BYTES) return `${file.name} is larger than ${Math.floor(QUOTATION_EVIDENCE_MAX_BYTES / (1024 * 1024))} MB. Choose a smaller file (for example a screenshot); nothing was uploaded.`;
  if (file.size === 0) return `${file.name} is empty. Choose another file; nothing was uploaded.`;
  return null;
}

export function EvidenceUploadForm({ version: v, action }: { version: QuoteVersionView; action: QuoteAction }) {
  const [hasFile, setHasFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [state, formAction] = useQuoteAction(action, {
    onSuccess: () => {
      setFormKey((k) => k + 1);
      setHasFile(false);
    },
  });
  const hint = `The customer’s written “yes” to version ${v.versionNo} (screenshot of the message, e-mail or signed copy). PDF, JPG, PNG or WebP, up to ${Math.floor(QUOTATION_EVIDENCE_MAX_BYTES / (1024 * 1024))} MB.`;
  const error = localError ?? quoteProblem(state, QFIELD.file, 'Choose the file again: PDF, JPG, PNG or WebP up to 4 MB.');
  return (
    <form key={formKey} action={formAction} noValidate className="flex flex-col gap-3" aria-label="Upload the written acceptance">
      <QuoteResultBox result={state} fields={[{ field: QFIELD.file, id: 'quote-evidence-file', label: 'The file' }]} successText={QUOTATION_TEXT.evidenceUploaded} />
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <input type="hidden" name={QFIELD.evidenceKind} value="acceptance_message" />
      <Field htmlFor="quote-evidence-file" label="Customer’s written acceptance" hint={hint} error={error ?? undefined}>
        <Input
          id="quote-evidence-file"
          name={QFIELD.file}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          invalid={Boolean(error)}
          aria-describedby={fieldDescribedBy('quote-evidence-file', { hint, error })}
          onChange={(e) => {
            // Checked here too (review E4-4): a large phone photo would otherwise fail without a reason. The server checks again.
            const file = e.target.files?.[0] ?? null;
            const problem = file ? evidenceFileProblem(file) : null;
            setLocalError(problem);
            setHasFile(Boolean(file) && !problem);
          }}
        />
      </Field>
      <div>
        <PendingButton pendingLabel="Uploading…" variant="secondary" disabled={!hasFile}>
          <Upload aria-hidden="true" /> Upload file
        </PendingButton>
      </div>
    </form>
  );
}

export function AcceptForm({ version: v, action }: { version: QuoteVersionView; action: QuoteAction }) {
  const [requestId] = useState(() => newRequestId());
  const stored = v.evidence.filter((e) => e.kind === 'acceptance_message' && e.status === 'stored');
  const [chosenEvidence, setEvidenceId] = useState('');
  // One stored acceptance file is the proof (it may arrive after this form mounted, on refresh).
  const evidenceId = stored.length === 1 ? stored[0]!.evidenceId : chosenEvidence;
  const [chosenTier, setTierKey] = useState('');
  const tierKey = chosenTier || (v.tiers.length === 1 ? v.tiers[0]!.tierKey : '');
  const [state, formAction] = useQuoteAction(action);
  const tierError = quoteProblem(state, QFIELD.acceptedTierKey, 'Choose the option the customer accepted.');
  const fileError = quoteProblem(state, QFIELD.evidenceId, 'Choose the file with the customer’s written acceptance.');
  const totalOf = (key: string) => v.money?.tiers.find((t) => t.tierKey === key)?.quotedTotalPaise ?? null;
  return (
    <HandForm action={formAction} noValidate className="flex flex-col gap-4" aria-label="Mark accepted">
      <QuoteResultBox
        result={state}
        fields={[
          { field: QFIELD.acceptedTierKey, id: 'quote-accept-tier', label: 'The option the customer accepted' },
          { field: QFIELD.evidenceId, id: 'quote-accept-file', label: 'The written acceptance file' },
        ]}
        successText={QUOTATION_TEXT.accepted}
      />
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <input type="hidden" name={QFIELD.contentHash} value={v.contentHash ?? ''} />
      <input type="hidden" name={QFIELD.requestId} value={requestId} />
      <ChoiceGroup id="quote-accept-tier" legend="Which option did the customer accept?" error={tierError ?? undefined}>
        {v.tiers.map((t) => (
          <Radio
            key={t.tierKey}
            id={`quote-accept-tier-${t.tierKey}`}
            name={QFIELD.acceptedTierKey}
            value={t.tierKey}
            checked={tierKey === t.tierKey}
            onChange={() => setTierKey(t.tierKey)}
            invalid={Boolean(tierError)}
            label={`${TIER_LABEL[t.tierKey]}${t.label ? ` · ${t.label}` : ''}`}
            description={totalOf(t.tierKey) ? `Quoted total ${inr0(totalOf(t.tierKey))}` : undefined}
          />
        ))}
      </ChoiceGroup>
      {stored.length > 1 ? (
        <ChoiceGroup id="quote-accept-file" legend="Which file shows the acceptance?" error={fileError ?? undefined}>
          {stored.map((e) => (
            <Radio key={e.evidenceId} id={`quote-accept-file-${e.evidenceId}`} name={QFIELD.evidenceId} value={e.evidenceId} checked={evidenceId === e.evidenceId} onChange={() => setEvidenceId(e.evidenceId)} invalid={Boolean(fileError)} label={e.fileName} />
          ))}
        </ChoiceGroup>
      ) : (
        <>
          <input type="hidden" name={QFIELD.evidenceId} value={evidenceId} />
          <p id="quote-accept-file" className="m-0 text-copy">
            {stored.length === 1 ? `Proof: ${stored[0]!.fileName}` : 'Upload the customer’s written acceptance first; it is the proof for this version.'}
          </p>
        </>
      )}
      <div>
        {/* Secondary: the page's one primary is the header's "Record the customer’s answer" (Echo M6). */}
        <PendingButton pendingLabel="Marking…" variant="secondary" disabled={!v.canAccept || stored.length === 0}>
          Mark accepted
        </PendingButton>
      </div>
      <p className="m-0 text-sm text-quiet">Accepting does not book anything. Any open draft of this quotation is discarded.</p>
    </HandForm>
  );
}

export function DeclineForm({ version: v, action }: { version: QuoteVersionView; action: QuoteAction }) {
  const [requestId] = useState(() => newRequestId());
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useQuoteAction(action);
  const options = [{ value: '', label: 'Choose a reason' }, ...DECLINE_REASONS.map((r) => ({ value: r, label: DECLINE_REASON_LABEL[r] }))];
  return (
    <HandForm action={formAction} noValidate className="flex flex-col gap-3" aria-label="Record the decline">
      <QuoteResultBox result={state} fields={[{ field: QFIELD.declineReason, id: 'quote-decline-reason', label: 'Reason' }]} successText={QUOTATION_TEXT.declined} />
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <input type="hidden" name={QFIELD.rowVersion} value={v.rowVersion} />
      <input type="hidden" name={QFIELD.requestId} value={requestId} />
      <div className="max-w-sm">
        <SelectField id="quote-decline-reason" name={QFIELD.declineReason} label="Why did the customer decline?" value={reason} onChange={setReason} options={options} error={quoteProblem(state, QFIELD.declineReason, 'Choose a reason.')} />
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-copy">Mark version {v.versionNo} as declined? You can still make a new version later.</span>
          <PendingButton pendingLabel="Marking…" variant="danger" disabled={!reason}>
            Yes, mark declined
          </PendingButton>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it open
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setConfirming(true)} disabled={!reason} className="min-h-11">
            Mark declined
          </Button>
        </div>
      )}
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// New version
// ---------------------------------------------------------------------------

export function NewVersionForm({ version: v, action, primary = false }: { version: QuoteVersionView; action: QuoteAction; primary?: boolean }) {
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useQuoteAction(action, {
    goTo: (data) => {
      const d = data as QuotationNewVersionResult | null;
      return d ? quotationHref(d.versionId) : null;
    },
  });
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <QuoteResultBox result={state} successText={null} />
      <input type="hidden" name={QFIELD.quotationId} value={v.quotationId} />
      <input type="hidden" name={QFIELD.baseVersionId} value={v.versionId} />
      <input type="hidden" name={QFIELD.requestId} value={requestId} />
      <div>
        <PendingButton pendingLabel="Opening…" variant={primary ? 'primary' : 'secondary'}>
          Make a new version from version {v.versionNo}
        </PendingButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Lead quotation: link the Deal Bitrix made from the Lead
// ---------------------------------------------------------------------------

function candidateReason(c: QuoteLinkCandidate): string | null {
  if (c.linkable) return null;
  if (!c.active) return 'Lost or rejected in Bitrix: cannot be linked.';
  if (!c.sameBranch) return `Belongs to the ${c.branchName} branch: ask that branch’s Manager.`;
  return 'Cannot be linked by you.';
}

export function LinkDealForm({ version: v, candidates, action }: { version: QuoteVersionView; candidates: QuoteLinkCandidate[]; action: QuoteAction }) {
  const linkable = candidates.filter((c) => c.linkable);
  const [chosenDeal, setDealId] = useState('');
  const dealId = chosenDeal || (linkable.length === 1 ? linkable[0]!.dealId : '');
  const [state, formAction] = useQuoteAction(action);
  const error = quoteProblem(state, QFIELD.dealId, 'Choose the Deal made from this Lead.');
  return (
    <HandForm action={formAction} noValidate className="flex flex-col gap-3" aria-label="Link the Deal">
      <QuoteResultBox result={state} fields={[{ field: QFIELD.dealId, id: 'quote-link-deal', label: 'The Deal' }]} successText={QUOTATION_TEXT.linked} />
      <input type="hidden" name={QFIELD.quotationId} value={v.quotationId} />
      {/* The quotation header's row version (links are on the quotation, not on a version). */}
      <input type="hidden" name={QFIELD.rowVersion} value={v.quotationRowVersion} />
      <ChoiceGroup id="quote-link-deal" legend="The Deal Bitrix made from this Lead" hint="Only Deals whose Bitrix record names this Lead are listed." error={error ?? undefined}>
        {candidates.map((c) => (
          <Radio
            key={c.dealId}
            id={`quote-link-${c.dealId}`}
            name={QFIELD.dealId}
            value={c.dealId}
            checked={dealId === c.dealId}
            onChange={() => setDealId(c.dealId)}
            disabled={!c.linkable}
            invalid={Boolean(error)}
            label={`${c.reference} · ${c.title}`}
            description={candidateReason(c) ?? `${c.branchName} branch`}
          />
        ))}
      </ChoiceGroup>
      <div>
        <PendingButton pendingLabel="Linking…" variant="primary" disabled={!v.canLinkDeal || linkable.length === 0}>
          Link this Deal
        </PendingButton>
      </div>
      <p className="m-0 text-sm text-quiet">Linking changes nothing in Bitrix.</p>
    </HandForm>
  );
}

// ---------------------------------------------------------------------------
// Start booking from this quotation
// ---------------------------------------------------------------------------

export function ConvertForm({ version: v, action }: { version: QuoteVersionView; action: QuoteAction }) {
  const [requestId] = useState(() => newRequestId());
  const dealId = v.linkedDealId ?? v.subject.dealId;
  const [state, formAction] = useQuoteAction(action, {
    goTo: (data) => {
      const d = data as QuotationConversionResult | null;
      if (!d) return null;
      rememberForNextPage(d.outcome === 'existing' ? QUOTATION_TEXT.convertedExisting : QUOTATION_TEXT.converted);
      return bookingHref(d.dealId);
    },
  });
  const refusedWithDraft = state && !state.ok && (state.code === 'draft_not_empty' || state.code === 'already_confirmed' || state.code === 'quotation_converted');
  return (
    <form action={formAction} noValidate className="flex max-w-md flex-col gap-3">
      <QuoteResultBox result={state} successText={null}>
        {refusedWithDraft && dealId ? (
          <p className="m-0 mt-1.5">
            <a href={bookingHref(dealId)} className={textLink}>
              Open the booking of this Deal
            </a>
          </p>
        ) : null}
      </QuoteResultBox>
      <input type="hidden" name={QFIELD.versionId} value={v.versionId} />
      <input type="hidden" name={QFIELD.contentHash} value={v.contentHash ?? ''} />
      <input type="hidden" name={QFIELD.requestId} value={requestId} />
      <div>
        <PendingButton pendingLabel="Starting the booking…" variant="primary" disabled={!v.canConvert}>
          Start booking from this quotation
        </PendingButton>
      </div>
      <p className="m-0 text-sm text-quiet">
        Copies this quotation into a new booking draft, once. Nothing is booked or paid.
      </p>
    </form>
  );
}
