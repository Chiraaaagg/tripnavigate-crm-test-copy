'use client';

import { CircleAlert, CircleCheck, Clock, Lock, TriangleAlert } from 'lucide-react';
import { useState, useTransition, type FormEvent } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { EVIDENCE_MIME_TYPES, ID_PROOF_COPY_CHIP_TEXT, ID_PROOF_COPY_TEXT, ID_PROOF_STATUS_LABEL, ID_PROOF_TEXT, type IdProofCopyView, type IdProofLimits, type TravellerIdProofView, type TravellerType } from '@/modules/fulfilment/contracts';
import { ID_PROOF_FIELD } from '@/modules/fulfilment/b11-forms';
import { dateText, idProofSlotsLeft } from './book-fields';
import { useTrackedDirty } from './draft-sync';
import { newRequestId, PendingButton, ResultBox, useB11Action, type UiResult } from './form-kit';
import type { B11Action } from './shapes';

/*
 * One traveller's identity proof (B1.2 freeze note §2.2, DEC-38 … DEC-42):
 * Aadhaar card or another ID as a photo or PDF, several files allowed (front
 * and back), required for every adult (a missing adult proof blocks
 * submission), optional for children. Each upload needs the tick "Customer
 * agreed to share this ID for this booking". No ID number is ever typed. The
 * slot lives inside the traveller row; it is its own small form (the
 * traveller fields join the passengers form through the form attribute, so
 * the two never nest). Rendered only when the view carries this traveller's
 * proofs: an absent list means the reader may not see them.
 * 21st.dev (phase-d design log): compact list of stored files with per-file
 * actions (ephraimduncan File Upload 4354) and a required consent tick
 * (cnippet-dev Multi-Consent 24989, adapted: refusal in words instead of a
 * silently disabled button). No drag-and-drop, no progress animation.
 */

export interface IdProofSlotProps {
  dealId: string;
  /** Saved traveller number, or null for a row not saved yet. */
  seq: number | null;
  rowNo: number;
  name: string;
  savedName: string | null;
  type: TravellerType;
  proofs: TravellerIdProofView[];
  limits: IdProofLimits | null;
  /** Attach (idProofCanEdit). */
  canEdit: boolean;
  /** Remove (idProofCanRemove when the database sends it; else idProofCanEdit). */
  canRemove: boolean;
  /** On the submitted booking: no "before you can submit" wording. */
  submitted?: boolean;
  uploadAction: B11Action;
  removeAction: B11Action;
  /** DEC-43: "Try again" on a Bitrix copy (retryIdProofCopyAction); absent = no button. */
  retryCopyAction?: B11Action;
}

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

export function TravellerIdProofSlot(p: IdProofSlotProps) {
  const who = p.name.trim() || `Traveller ${p.rowNo}`;
  const adult = p.type === 'adult';
  const stored = p.proofs.filter((f) => f.status === 'stored');
  const left = idProofSlotsLeft(p.proofs, p.limits);
  const max = p.limits?.maxFilesPerTraveller ?? 4;
  const idBase = `passengers-${p.rowNo}-idproof`;
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line bg-canvas px-3.5 py-3" role="group" aria-labelledby={`${idBase}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${idBase}-title`} className="m-0 font-semibold text-ink">
          ID proof (Aadhaar card or another ID) · {who}
        </p>
        <span className="text-sm text-quiet">{adult ? 'Required for adults' : 'Optional for children'}</span>
      </div>
      <div className="flex gap-2 text-sm text-quiet">
        <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
        <div className="min-w-0">
          {/* Copy BI-02: one short line; the full list behind "Why?". */}
          <p className="m-0">Private. Opened only by staff working on this booking; each view is recorded.</p>
          <details className="mt-0.5">
            <summary className="cursor-pointer font-medium text-brand-strong">Why?</summary>
            <p className="m-0 mt-1.5">The salesperson, the branch Manager, Accounts, and the Purchase, Flight or Visa &amp; Passport colleague with a task on this deal can open it.</p>
          </details>
        </div>
      </div>
      {stored.length === 0 && p.seq !== null ? (
        adult ? (
          <p className="m-0 flex gap-2 text-sm font-medium text-status-danger">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {`ID proof needed for ${who}`}
          </p>
        ) : (
          <p className="m-0 flex gap-2 text-sm text-copy">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
            No ID proof attached for {who} (optional for a child).
          </p>
        )
      ) : null}
      {p.proofs.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={`ID proof files of ${who}`}>
          {p.proofs.map((f) => (
            <ProofFile key={f.fileId} dealId={p.dealId} file={f} canRemove={p.canRemove} removeAction={p.removeAction} retryCopyAction={p.retryCopyAction} />
          ))}
        </ul>
      ) : null}
      {p.seq === null ? (
        <p className="m-0 text-sm text-quiet">Save the passengers first, then attach this traveller’s ID proof.</p>
      ) : !p.canEdit ? (
        <p className="m-0 text-sm text-quiet">{p.canRemove ? 'Attaching is paused for this booking. A wrong file can still be removed.' : 'Attaching and removing ID proof is paused for this booking.'}</p>
      ) : left === 0 ? (
        <p className="m-0 text-sm text-copy">{ID_PROOF_TEXT.limit}</p>
      ) : (
        <UploadForm dealId={p.dealId} seq={p.seq} rowNo={p.rowNo} who={who} maxBytes={p.limits?.maxBytes ?? 4 * 1024 * 1024} hint={`PDF, JPG, PNG or WebP, up to ${mb(p.limits?.maxBytes ?? 4 * 1024 * 1024)} each.${left !== null ? ` ${left} of ${max} files left.` : ''}`} action={p.uploadAction} />
      )}
    </div>
  );
}

function ProofFile({ dealId, file, canRemove, removeAction, retryCopyAction }: { dealId: string; file: TravellerIdProofView; canRemove: boolean; removeAction: B11Action; retryCopyAction?: B11Action }) {
  const [state, formAction] = useB11Action(removeAction, {});
  const ok = file.status === 'stored';
  const Icon = ok ? CircleCheck : file.status === 'failed' ? TriangleAlert : CircleAlert;
  return (
    <li className={cn('m-0 flex flex-wrap items-center gap-3 rounded-control border px-3 py-2', ok ? 'border-line bg-card' : 'border-status-danger-line bg-status-danger-tint')}>
      <Icon aria-hidden="true" className={cn('size-4 shrink-0', ok ? 'text-status-success' : 'text-status-danger')} />
      <div className="min-w-40 flex-1">
        <p className="m-0 font-medium wrap-anywhere text-ink">{file.fileName}</p>
        <p className={cn('m-0 text-sm', ok ? 'text-quiet' : 'text-status-danger')}>
          {ID_PROOF_STATUS_LABEL[file.status]} · {file.sizeLabel}
          {file.uploadedByYou ? ' · by you' : file.uploadedByName ? ` · by ${file.uploadedByName}` : ''}
          {file.consentByName ? ` · customer agreed (ticked by ${file.consentByName}, ${dateText(file.consentAt)})` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {file.downloadHref ? (
          <a className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'min-h-11')} href={file.downloadHref} rel="noopener">
            Open<span className="sr-only"> {file.fileName}</span>
          </a>
        ) : null}
        {canRemove ? (
          <form
            action={formAction}
            noValidate
            onSubmit={(e) => {
              // Soft removal (the stored file is kept for the record), but still ask first.
              if (!window.confirm(`Remove ${file.fileName} from this traveller’s ID proof?`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="dealId" value={dealId} />
            <input type="hidden" name="fileId" value={file.fileId} />
            <input type="hidden" name="fileRowVersion" value={file.rowVersion} />
            <PendingButton pendingLabel="Removing…" variant="ghost">
              Remove<span className="sr-only"> {file.fileName}</span>
            </PendingButton>
          </form>
        ) : null}
      </div>
      {state && !state.ok ? <ResultBox result={state} className="basis-full" /> : null}
      {file.bitrixCopy ? <BitrixCopyLine dealId={dealId} copy={file.bitrixCopy} fileName={file.fileName} retryAction={retryCopyAction} /> : null}
    </li>
  );
}

function UploadForm({ dealId, seq, rowNo, who, hint, maxBytes, action }: { dealId: string; seq: number; rowNo: number; who: string; hint: string; maxBytes: number; action: B11Action }) {
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [inputKey, setInputKey] = useState(0);
  const [chosen, setChosen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [localRefusal, setLocalRefusal] = useState<string | null>(null);
  const [state, formAction] = useB11Action(action, {
    onSuccess: () => {
      setRequestId(newRequestId());
      setInputKey((k) => k + 1);
      setChosen(false);
      setConsent(false);
    },
  });
  useTrackedDirty(`passengers-idproof-${seq}`, 'passengers', `ID proof of ${who} (chosen, not attached)`, 25 + rowNo / 100, chosen, `passengers-${rowNo}-idproof-file`);
  const id = `passengers-${rowNo}-idproof`;
  const [pending, startSend] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Submitted by hand, never through the form's action: React 19 resets a form after its action
    // returns, and the reset unticks the consent box on screen while the state still says ticked
    // (Echo follow-up: the second file for the same passenger was refused).
    e.preventDefault();
    if (pending) return;
    if (!consent) {
      // Refused in words before anything is sent (the server refuses too: consent_required).
      e.preventDefault();
      setLocalRefusal(ID_PROOF_TEXT.consentRequired);
      requestAnimationFrame(() => document.getElementById(`${id}-consent`)?.focus());
      return;
    }
    const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
    if (!file) {
      e.preventDefault();
      setLocalRefusal('Choose the ID proof file first. Nothing was uploaded.');
      requestAnimationFrame(() => document.getElementById(`${id}-file`)?.focus());
      return;
    }
    if (file.size > maxBytes || !(EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
      // Checked here first so a large or wrong file is never sent; the server checks again.
      e.preventDefault();
      setLocalRefusal(`${ID_PROOF_TEXT.rejected} Nothing was uploaded.`);
      requestAnimationFrame(() => document.getElementById(`${id}-file`)?.focus());
      return;
    }
    setLocalRefusal(null);
    const fd = new FormData(e.currentTarget);
    startSend(() => formAction(fd));
  };
  const shown: UiResult | null = localRefusal
    ? { ok: false, code: localRefusal === ID_PROOF_TEXT.consentRequired ? 'consent_required' : 'evidence_rejected', message: localRefusal, fields: [localRefusal === ID_PROOF_TEXT.consentRequired ? 'consent' : 'file'] }
    : state;
  return (
    <form onSubmit={onSubmit} noValidate aria-label={`Attach ID proof for ${who}`} className="flex flex-col gap-3">
      <ResultBox
        result={shown}
        fields={[
          { field: 'consent', id: `${id}-consent`, label: ID_PROOF_TEXT.consentLabel },
          { field: 'file', id: `${id}-file`, label: 'ID proof file' },
        ]}
        successText={ID_PROOF_TEXT.uploaded}
      />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="travellerSeq" value={seq} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-file`} className="font-medium text-ink">
          ID proof file
        </label>
        <p id={`${id}-file-hint`} className="m-0 text-sm text-quiet">
          {hint} Front and back can be separate files.
        </p>
        <input
          key={inputKey}
          id={`${id}-file`}
          name="file"
          type="file"
          accept={EVIDENCE_MIME_TYPES.join(',')}
          aria-describedby={`${id}-file-hint`}
          onChange={(e) => setChosen(Boolean(e.target.files && e.target.files.length > 0))}
          className="block w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
        />
      </div>
      <div className="flex min-h-11 items-center gap-2.5">
        <input
          id={`${id}-consent`}
          name="consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked);
            if (e.target.checked) setLocalRefusal(null);
          }}
          aria-invalid={localRefusal === ID_PROOF_TEXT.consentRequired || (state && !state.ok && state.code === 'consent_required') ? true : undefined}
          className="m-0 size-5 min-h-0 shrink-0 cursor-pointer accent-brand-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong"
        />
        <label htmlFor={`${id}-consent`} className="flex min-h-11 cursor-pointer items-center text-base text-ink">
          {ID_PROOF_TEXT.consentLabel}
        </label>
      </div>
      <div>
        <Button type="submit" variant="secondary" size="lg" loading={pending} className="h-auto min-h-11 py-2 whitespace-normal">
          {pending ? 'Attaching…' : `Attach ID proof for ${who}`}
        </Button>
      </div>
    </form>
  );
}

const COPY_ICON: Record<IdProofCopyView['status'], typeof CircleCheck> = {
  pending: Clock,
  unknown: Clock,
  sent: CircleCheck,
  failed: TriangleAlert,
  cancelled: CircleAlert,
  needs_manual_check: TriangleAlert,
};

/**
 * DEC-43: where the Bitrix copy of this file stands, always in words (never
 * colour alone), with "Try again" when this person may retry, or who can.
 */
function BitrixCopyLine({ dealId, copy, fileName, retryAction }: { dealId: string; copy: IdProofCopyView; fileName: string; retryAction?: B11Action }) {
  const Icon = COPY_ICON[copy.status] ?? Clock;
  const bad = copy.status === 'failed' || copy.status === 'needs_manual_check';
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2 text-sm">
      <div className="m-0 flex min-w-48 flex-1 gap-2 text-copy">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', bad ? 'text-status-danger' : copy.status === 'sent' ? 'text-status-success' : 'text-faint')} />
        <div className="min-w-0">
          {/* BI-08: a short status for staff; the full reason sits behind "Why?". */}
          <span className="font-semibold text-ink">{ID_PROOF_COPY_TEXT.title}:</span> {ID_PROOF_COPY_CHIP_TEXT[copy.status] ?? copy.statusText}
          {copy.status === 'sent' && copy.sentAt ? ` (${dateText(copy.sentAt)})` : ''}
          {copy.status !== 'sent' ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-quiet">Why?</summary>
              <span className="block">
                {copy.statusText}
                {copy.reasonText ? ` ${copy.reasonText}` : ''}
                {copy.attempts > 0 ? ` (tried ${copy.attempts} of ${copy.maxAttempts} times)` : ''}
              </span>
            </details>
          ) : null}
        </div>
      </div>
      {copy.canRetry && retryAction ? (
        <CopyRetryForm dealId={dealId} jobId={copy.jobId} fileName={fileName} action={retryAction} />
      ) : copy.retryNeedsSuperAdmin ? (
        <span className="text-quiet">{ID_PROOF_COPY_TEXT.askSuperAdmin}</span>
      ) : null}
    </div>
  );
}

/** "Try again" for one copy job (Book now; the Super Admin's manual checks pass no Deal). */
export function CopyRetryForm({ dealId, jobId, fileName, action }: { dealId: string | null; jobId: string; fileName: string; action: B11Action }) {
  const [state, formAction] = useB11Action(action, {});
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <input type="hidden" name="dealId" value={dealId ?? ''} />
      <input type="hidden" name={ID_PROOF_FIELD.copyJobId} value={jobId} />
      <div>
        <PendingButton pendingLabel="Asking…" variant="secondary">
          {ID_PROOF_COPY_TEXT.retry}
          <span className="sr-only"> copying {fileName} to Bitrix</span>
        </PendingButton>
      </div>
      {state ? <ResultBox result={state} /> : null}
    </form>
  );
}
