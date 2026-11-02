'use client';

import { CircleAlert, FileText, Lock, Paperclip, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EVIDENCE_MIME_TYPES, ID_PROOF_TEXT, type BookTravellerView } from '@/modules/fulfilment/contracts';
import { ID_PROOF_FIELD } from '@/modules/fulfilment/b11-forms';
import { guard } from '../booking-forms';
import { idProofSlotsLeft } from '../b11/book-fields';
import { newRequestId, normaliseResult, type UiResult } from '../b11/form-kit';
import type { BookNowView } from '../b11/shapes';
import { refusalReason, useSaveQueue } from './autosave-queue';
import { useFormToast } from './form-toast';
import type { PassengerActions } from './passengers-card';

/*
 * "Attach ID proof" from a passenger row (Book now v2, owner-approved
 * prototype openIdProof). Private upload with the customer's consent tick;
 * each chosen file is one upload request (one at a time, through the page's
 * save queue), and a file shows as attached only after its upload finished.
 * Change 10: before upload the dialog says the file is also copied to the
 * Bitrix Deal, but only when that copy applies to this Deal (lead ruling D5:
 * saying it while copying is off would be untrue).
 */

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

type Proof = NonNullable<BookTravellerView['idProofs']>[number];

async function runAction(action: PassengerActions['uploadIdProof'], fd: FormData): Promise<UiResult> {
  return normaliseResult(await guard(action as never)(null, fd)) as UiResult;
}

export function IdProofDialog({
  view,
  traveller,
  actions,
  copiesToBitrix,
  onClose,
}: {
  view: BookNowView;
  traveller: BookTravellerView;
  actions: PassengerActions;
  /** The ID-proof copy to the Bitrix Deal applies to this Deal (D5). */
  copiesToBitrix: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const queue = useSaveQueue();
  const toast = useFormToast();
  const name = traveller.fullName;
  const proofs = (traveller.idProofs ?? []).filter((p) => p.status === 'stored' || p.status === 'pending_upload');
  const limits = view.idProofLimits;
  const maxBytes = limits?.maxBytes ?? 4 * 1024 * 1024;
  const max = limits?.maxFilesPerTraveller ?? 4;
  const left = idProofSlotsLeft(traveller.idProofs ?? [], limits) ?? Math.max(0, max - proofs.length);
  const [files, setFiles] = useState<File[]>([]);
  const [agree, setAgree] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const canEdit = view.idProofCanEdit;

  const attach = async () => {
    if (busy) return;
    if (!agree) {
      setProblem('Tick the customer’s agreement first. Nothing was uploaded.');
      requestAnimationFrame(() => document.getElementById('idp-agree')?.focus());
      return;
    }
    if (files.length === 0) {
      setProblem('Choose the ID proof file first. Nothing was uploaded.');
      requestAnimationFrame(() => document.getElementById('idp-file')?.focus());
      return;
    }
    const bad = files.find((f) => f.size > maxBytes || !(EVIDENCE_MIME_TYPES as readonly string[]).includes(f.type));
    if (bad) {
      setProblem(`${bad.name}: ${ID_PROOF_TEXT.rejected} Nothing was uploaded.`);
      return;
    }
    if (files.length > left) {
      setProblem(`${left} of ${max} files left. Choose fewer files. Nothing was uploaded.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    const attached: string[] = [];
    try {
      for (const [i, file] of files.entries()) {
        const fd = new FormData();
        fd.set('dealId', view.dealId);
        fd.set(ID_PROOF_FIELD.travellerSeq, String(traveller.seq));
        fd.set('requestId', newRequestId());
        fd.set(ID_PROOF_FIELD.consent, 'on');
        fd.set('file', file);
        const r = await queue.run(() => runAction(actions.uploadIdProof, fd));
        if (!r.ok) {
          // Say exactly what happened to each file; the failed and untried files stay chosen.
          const untried = files.slice(i + 1).map((x) => x.name);
          setProblem(
            [attached.length > 0 ? `Attached: ${attached.join(', ')}.` : 'Nothing was attached.', `Not attached: ${file.name} (${refusalReason(r)})`, untried.length > 0 ? `Not tried yet: ${untried.join(', ')}.` : '', 'The files not attached are still chosen: fix the problem and attach again.']
              .filter(Boolean)
              .join(' '),
          );
          setFiles(files.slice(i));
          router.refresh();
          return;
        }
        attached.push(file.name);
      }
      setFiles([]);
      router.refresh();
      toast('Identity proof attached. Only the people who need it can open it.');
      onClose();
    } finally {
      setBusy(false);
      setInputKey((k) => k + 1);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent closeLabel="Close">
        <DialogHeader>
          <DialogTitle className="text-lg">ID proof · {name}</DialogTitle>
          <DialogDescription className="sr-only">Private upload. The customer must agree first.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3.5">
          <div className="flex gap-2.5 rounded-control border border-line bg-wash px-3.5 py-3 text-sm text-copy">
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />
            <p className="m-0">Private. Opened only by staff working on this booking; each view is recorded.</p>
          </div>
          {copiesToBitrix ? (
            <div className="flex gap-2.5 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-sm text-copy">
              <Upload aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
              <p className="m-0">
                <b>This file is also copied to the Bitrix Deal</b>, in the Deal’s ID proof field. Bitrix keeps its own copy.
              </p>
            </div>
          ) : null}
          {proofs.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={`ID proof files of ${name}`}>
              {proofs.map((p) => (
                <ProofLine key={p.fileId} dealId={view.dealId} file={p} canRemove={view.idProofCanRemove} removeAction={actions.removeIdProof} />
              ))}
            </ul>
          ) : null}
          {canEdit ? (
            <div className="flex flex-col gap-2.5 rounded-control border border-dashed border-control bg-canvas p-3.5">
              <label htmlFor="idp-file" className="font-semibold text-ink">
                ID proof file
              </label>
              <input
                key={inputKey}
                id="idp-file"
                type="file"
                multiple
                accept={EVIDENCE_MIME_TYPES.join(',')}
                aria-describedby="idp-file-hint"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setFiles((fs) => [...fs, ...picked]);
                  setProblem(null);
                  setInputKey((k) => k + 1);
                }}
                className={cn('block w-full text-base text-ink file:mr-3 file:cursor-pointer file:rounded-control file:border file:border-line-strong file:bg-card file:px-3 file:py-1.5 file:font-semibold file:text-ink', focusRing)}
              />
              {files.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-copy" aria-label="Chosen files, not attached yet">
                  {files.map((x, i) => (
                    <li key={`${x.name}-${i}`} className="flex items-center justify-between gap-2">
                      <span className="wrap-anywhere">{x.name}</span>
                      <Button variant="link" size="sm" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                        Remove<span className="sr-only"> {x.name}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p id="idp-file-hint" className="m-0 text-sm text-quiet">
                PDF, JPG, PNG or WebP, up to {mb(maxBytes)} each. {left} of {max} files left. Front and back can be separate files.
              </p>
              <label htmlFor="idp-agree" className="flex cursor-pointer items-start gap-2.5">
                <input id="idp-agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className={cn('m-0 mt-0.5 size-4 shrink-0 cursor-pointer accent-brand-strong', focusRing)} />
                <span>{ID_PROOF_TEXT.consentLabel}</span>
              </label>
              {problem ? (
                <p role="alert" className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>{problem}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <p className="m-0 text-sm text-quiet">{view.idProofCanRemove ? 'Attaching is paused for this booking. A wrong file can still be removed.' : 'Attaching and removing ID proof is paused for this booking.'}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Done
          </Button>
          {canEdit ? (
            <Button variant="primary" loading={busy} onClick={() => void attach()} className="h-auto min-h-10 py-2 whitespace-normal">
              {busy ? null : <Paperclip aria-hidden="true" />}
              {busy ? 'Attaching…' : `Attach ID proof for ${name}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProofLine({ dealId, file, canRemove, removeAction }: { dealId: string; file: Proof; canRemove: boolean; removeAction: PassengerActions['removeIdProof'] }) {
  const router = useRouter();
  const queue = useSaveQueue();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    if (busy || !window.confirm(`Remove ${file.fileName} from this traveller’s ID proof?`)) return;
    setBusy(true);
    const fd = new FormData();
    fd.set('dealId', dealId);
    fd.set('fileId', file.fileId);
    fd.set('fileRowVersion', String(file.rowVersion));
    const r = await queue.run(() => runAction(removeAction, fd));
    setBusy(false);
    if (r.ok) router.refresh();
    else setProblem(refusalReason(r));
  };
  return (
    <li className="m-0 flex flex-wrap items-center justify-between gap-2.5 rounded-chip border border-line bg-card px-2.5 py-2 text-sm">
      <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
        <FileText aria-hidden="true" className="size-4 shrink-0" />
        {file.downloadHref ? (
          <a href={file.downloadHref} rel="noopener" className={cn('text-copy underline-offset-4 hover:underline', focusRing)}>
            {file.fileName}
          </a>
        ) : (
          file.fileName
        )}
      </span>
      {canRemove ? (
        <Button variant="link" size="sm" loading={busy} onClick={() => void remove()}>
          Remove<span className="sr-only"> {file.fileName}</span>
        </Button>
      ) : null}
      {problem ? (
        <p role="alert" className="m-0 basis-full text-sm font-medium text-status-danger">
          {problem}
        </p>
      ) : null}
    </li>
  );
}
