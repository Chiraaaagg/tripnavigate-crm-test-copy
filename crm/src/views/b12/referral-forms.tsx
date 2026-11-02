'use client';

import { Link2, Unlink, UserRoundPen, Archive, RotateCcw } from 'lucide-react';
import { startTransition, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { cn, focusRing } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import {
  REFERRAL_MANUAL_CLOSE_REASONS,
  REFERRAL_TEXT_LIMITS,
  REFERRAL_UNLINK_REASONS,
  RFIELD,
  type NewWorkVM,
  type ReferralCreatedVM,
  type ReferralLinkStepVM,
  type ReferralLinkVM,
  type ReferralSourceKind,
  type WorkListKind,
} from '@/modules/quotations/work-contract';
import { AreaField, SelectField, TextField } from '../b11/controls';
import { REFERRAL_CLOSE_REASON_LABEL, REFERRAL_SOURCE_LABEL, REFERRAL_UNLINK_REASON_LABEL } from '@/modules/quotations/work-labels';
import { newRequestId } from '../b11/form-kit';
import { defaultReferralTitle } from './referral-text';
import { dataOf, QuoteResultBox, quoteProblem, useQuoteAction, type QuoteAction } from './quote-kit';

/*
 * Referral draft forms (Direction A Batch 3; copy-catalogue §16.5 DA-52..DA-76;
 * catalog gaps G11 Link-to-Bitrix step and G12 referral create form, register
 * §3 and §12). Client components posting Terra's actions with the frozen
 * RFIELD names. Every value is held in state, so a refusal keeps what was
 * typed; dialogs post by hand so React never resets them. The link step never
 * preselects a candidate and always asks for confirmation (contracts B.4,
 * lead decision L4); removing a link needs a reason and a 10–500 character
 * note (A4). Nothing here sends anything to the customer or to Bitrix.
 */

/** Every referral action: same ok/code/message/fields answer as the quotation actions (fields = RFIELD names). */
export interface ReferralActions {
  /** referral_draft_save (Edit customer details). Optional: hidden when absent. */
  save?: QuoteAction;
  close: QuoteAction;
  reopen: QuoteAction;
  reassign: QuoteAction;
  link: QuoteAction;
  unlink: QuoteAction;
}

/** Current customer details for "Edit customer details" (referral_draft_get.customer + source). */
export interface ReferralCustomerFormVM {
  customerName: string;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
  sourceKind: ReferralSourceKind | null;
  sourceNote: string | null;
}

const textLink = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

// ---------------------------------------------------------------------------
// Page-level result line (Echo-B M1): a successful link, removal, close, reopen or owner change
// re-renders the page (the server revalidates), which swaps or removes the form that was used.
// The answer is therefore shown in one line above the tabs, which stays mounted, and focus moves
// to it so keyboard and screen-reader users hear what happened.
// ---------------------------------------------------------------------------

const resultListeners = new Set<(text: string) => void>();

/** Shows `text` in the draft page's result line (no-op when the line is not on the page). */
export function announceDraftResult(text: string) {
  for (const listener of resultListeners) listener(text);
}

/** Wraps an action so its success message reaches the page-level result line. */
function announcing(action: QuoteAction): QuoteAction {
  return async (prev, formData) => {
    const result = await action(prev, formData);
    if (result.ok) announceDraftResult(result.message);
    return result;
  };
}

/** A result that arrived with the page (link / unlink redirect, Terra resultNotice): shown once and focused, so it is heard. */
export function DraftResultNotice({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [text]);
  return (
    <div ref={ref} tabIndex={-1} role="status" data-slot="draft-result-notice" className="mb-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong">
      <Notice tone="success">
        <p>{text}</p>
      </Notice>
    </div>
  );
}

export function DraftResultLine() {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const listener = (t: string) => setText(t);
    resultListeners.add(listener);
    return () => {
      resultListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!text) return;
    // After the dialog has closed and returned focus, move it here.
    const timer = window.setTimeout(() => ref.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [text]);
  return (
    <div role="status" aria-live="polite" data-slot="draft-result">
      {text ? (
        <div ref={ref} tabIndex={-1} className="mb-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong">
          <Notice tone="success">
            <p>{text}</p>
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

const NOTE_RULE = `${REFERRAL_TEXT_LIMITS.reasonMin} to ${REFERRAL_TEXT_LIMITS.reasonMax} characters, saved with your name`;

/** Posts a form by hand (keeps a dialog's typed values after a refusal; React does not reset the form). */
function postByHand(formAction: (fd: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    startTransition(() => formAction(fd));
  };
}

function rowVersionInputs(draftId: string, rowVersion: number) {
  return (
    <>
      <input type="hidden" name={RFIELD.draftId} value={draftId} />
      <input type="hidden" name={RFIELD.rowVersion} value={String(rowVersion)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Create (QN / IN, DA-52..DA-57; G12)
// ---------------------------------------------------------------------------

const CREATE_WORDS: Record<WorkListKind, { heading: string; button: string; pending: string; open: string; titleHint: string }> = {
  quotations: {
    heading: 'New referral quotation',
    button: 'Create referral quotation',
    pending: 'Creating…',
    open: 'Open the new quotation',
    titleHint: 'Printed at the top of the quotation. You cannot change it later.',
  },
  itineraries: {
    heading: 'New referral itinerary',
    button: 'Create referral itinerary',
    pending: 'Creating…',
    open: 'Open the new itinerary',
    titleHint: 'Printed at the top of the itinerary.',
  },
};

/**
 * The referral create form (G12). Only the customer name and the title are
 * required. With no possible duplicate the browser opens the new quotation
 * or itinerary; with one, the form stays, says the draft was made and lists
 * the other drafts (DA-57) — it never blocks.
 */
export function ReferralCreateForm({ kind, referral, action }: { kind: WorkListKind; referral: NewWorkVM['referral']; action: QuoteAction }) {
  const words = CREATE_WORDS[kind];
  const [requestId] = useState(() => newRequestId());
  const [v, setV] = useState({
    branchId: referral.branches.length === 1 ? referral.branches[0]!.id : '',
    customerName: '',
    mobile: '',
    email: '',
    companyName: '',
    sourceKind: '',
    sourceNote: '',
    title: '',
  });
  const set = (key: keyof typeof v) => (value: string) => setV((prev) => ({ ...prev, [key]: value }));
  const [state, formAction, pending] = useQuoteAction(action, {
    goTo: (data) => {
      const d = data as ReferralCreatedVM | null;
      return d && d.possibleDuplicates.length === 0 ? d.href : null;
    },
  });
  const created = dataOf<ReferralCreatedVM>(state);
  const id = (name: string) => `referral-${kind}-${name}`;
  if (created && created.possibleDuplicates.length > 0) {
    return (
      <div className="flex flex-col gap-3" data-slot="referral-created">
        <Notice tone="success" role="status" title={created.createdText}>
          <p>
            This mobile number is already on{' '}
            {created.possibleDuplicates.map((d, i) => (
              <span key={d.reference}>
                {i > 0 ? ', ' : ''}
                {d.href ? (
                  <a href={d.href} className={textLink}>
                    {d.reference}
                  </a>
                ) : (
                  d.reference
                )}
              </span>
            ))}
            . Open one of those, or carry on with the new draft.
          </p>
        </Notice>
        <div>
          <a href={created.href} className={cn('inline-flex min-h-11 items-center gap-2 rounded-control border border-brand-strong bg-brand-strong px-4 font-semibold text-white no-underline shadow-button hover:bg-brand-deep hover:text-white', focusRing)}>
            {words.open}
          </a>
        </div>
      </div>
    );
  }
  const fields = [
    { field: RFIELD.branchId, id: id('branch'), label: 'Branch' },
    { field: RFIELD.customerName, id: id('customer'), label: 'Customer name: 1 to 120 characters' },
    { field: RFIELD.mobile, id: id('mobile'), label: 'Mobile: 10 digits starting 6 to 9' },
    { field: RFIELD.email, id: id('email'), label: 'Email' },
    { field: RFIELD.companyName, id: id('company'), label: 'Company: up to 200 characters' },
    { field: RFIELD.sourceKind, id: id('source'), label: 'How did they reach us?' },
    { field: RFIELD.sourceNote, id: id('source-note'), label: 'Who referred them: up to 200 characters' },
    { field: RFIELD.title, id: id('title'), label: 'Title: up to 200 characters' },
  ];
  return (
    // Posted by hand: React’s automatic form reset would clear the selects after a refusal. POST (never GET) so
    // nothing typed reaches the address before script loads.
    <form method="post" onSubmit={postByHand(formAction)} noValidate className="flex flex-col gap-4" aria-labelledby={id('heading')}>
      <h3 id={id('heading')} className="m-0 text-lg font-semibold text-ink">
        {words.heading}
      </h3>
      <p className="m-0 text-copy">For a customer who is not in Bitrix yet. Only the name is required. You can link it to a Bitrix lead or deal later.</p>
      <QuoteResultBox result={state} fields={fields} successText={null} />
      <input type="hidden" name={RFIELD.requestId} value={requestId} />
      {referral.branches.length > 1 ? (
        <SelectField
          id={id('branch')}
          name={RFIELD.branchId}
          label="Branch"
          value={v.branchId}
          onChange={set('branchId')}
          options={[{ value: '', label: 'Choose the branch' }, ...referral.branches.map((b) => ({ value: b.id, label: b.name }))]}
          error={quoteProblem(state, RFIELD.branchId, 'Choose one of your branches.')}
        />
      ) : (
        <input type="hidden" name={RFIELD.branchId} value={v.branchId} />
      )}
      <TextField
        id={id('customer')}
        name={RFIELD.customerName}
        label="Customer name"
        value={v.customerName}
        onChange={set('customerName')}
        maxLength={REFERRAL_TEXT_LIMITS.customerName}
        autoComplete="off"
        error={quoteProblem(state, RFIELD.customerName, 'Type the customer’s name (1 to 120 characters).')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={id('mobile')}
          name={RFIELD.mobile}
          label="Mobile"
          optional
          type="tel"
          inputMode="tel"
          value={v.mobile}
          onChange={set('mobile')}
          maxLength={14}
          error={quoteProblem(state, RFIELD.mobile, 'Type a 10-digit Indian mobile number starting with 6, 7, 8 or 9.')}
        />
        <TextField
          id={id('email')}
          name={RFIELD.email}
          label="Email"
          optional
          type="email"
          inputMode="email"
          value={v.email}
          onChange={set('email')}
          maxLength={REFERRAL_TEXT_LIMITS.email}
          error={quoteProblem(state, RFIELD.email, 'Type a full email address, or leave it empty.')}
        />
      </div>
      <TextField
        id={id('company')}
        name={RFIELD.companyName}
        label="Company"
        optional
        value={v.companyName}
        onChange={set('companyName')}
        maxLength={REFERRAL_TEXT_LIMITS.companyName}
        error={quoteProblem(state, RFIELD.companyName, 'Up to 200 characters.')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={id('source')}
          name={RFIELD.sourceKind}
          label="How did they reach us?"
          optional
          value={v.sourceKind}
          onChange={set('sourceKind')}
          options={[{ value: '', label: 'Not recorded' }, ...referral.sourceKinds]}
          error={quoteProblem(state, RFIELD.sourceKind, 'Choose one of the listed ways.')}
        />
        <TextField
          id={id('source-note')}
          name={RFIELD.sourceNote}
          label="Who referred them?"
          optional
          value={v.sourceNote}
          onChange={set('sourceNote')}
          maxLength={REFERRAL_TEXT_LIMITS.sourceNote}
          error={quoteProblem(state, RFIELD.sourceNote, 'Up to 200 characters.')}
        />
      </div>
      <TextField
        id={id('title')}
        name={RFIELD.title}
        label="Title"
        optional
        // DA-213: an empty title prints "Trip for {customer name}" and cannot be changed later.
        hint={referral.titleHint ?? `${words.titleHint} Left empty, it reads “${defaultReferralTitle(v.customerName)}”.`}
        value={v.title}
        onChange={set('title')}
        maxLength={200}
        error={quoteProblem(state, RFIELD.title, 'Up to 200 characters.')}
      />
      <p className="m-0 text-sm text-quiet">Nothing is sent and nothing is put in Bitrix.</p>
      <div>
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending} className="h-auto min-h-11 py-2 whitespace-normal">
          {pending ? words.pending : words.button}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Edit customer details (referral_draft_save)
// ---------------------------------------------------------------------------

export function ReferralCustomerForm({ draftId, rowVersion, customer, action }: { draftId: string; rowVersion: number; customer: ReferralCustomerFormVM; action: QuoteAction }) {
  const [v, setV] = useState({
    customerName: customer.customerName,
    mobile: customer.mobile ?? '',
    email: customer.email ?? '',
    companyName: customer.companyName ?? '',
    sourceKind: customer.sourceKind ?? '',
    sourceNote: customer.sourceNote ?? '',
  });
  const set = (key: keyof typeof v) => (value: string) => setV((prev) => ({ ...prev, [key]: value }));
  const [state, formAction, pending] = useQuoteAction(action);
  const fields = [
    { field: RFIELD.customerName, id: 'referral-edit-customer', label: 'Customer name: 1 to 120 characters' },
    { field: RFIELD.mobile, id: 'referral-edit-mobile', label: 'Mobile: 10 digits starting 6 to 9' },
    { field: RFIELD.email, id: 'referral-edit-email', label: 'Email' },
    { field: RFIELD.companyName, id: 'referral-edit-company', label: 'Company: up to 200 characters' },
    { field: RFIELD.sourceKind, id: 'referral-edit-source', label: 'How did they reach us?' },
    { field: RFIELD.sourceNote, id: 'referral-edit-source-note', label: 'Who referred them: up to 200 characters' },
  ];
  return (
    <details className="group rounded-card border border-line bg-card" data-slot="referral-edit">
      <summary className={cn('flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-card px-4.5 py-2.5 font-semibold text-brand-strong hover:bg-wash [&::-webkit-details-marker]:hidden', focusRing)}>
        Edit customer details
      </summary>
      <form method="post" onSubmit={postByHand(formAction)} noValidate className="flex flex-col gap-4 border-t border-line px-4.5 py-4" aria-label="Edit customer details">
        <QuoteResultBox result={state} fields={fields} successText="Customer details saved." />
        {rowVersionInputs(draftId, rowVersion)}
        <TextField id="referral-edit-customer" name={RFIELD.customerName} label="Customer name" value={v.customerName} onChange={set('customerName')} maxLength={REFERRAL_TEXT_LIMITS.customerName} error={quoteProblem(state, RFIELD.customerName, 'Type the customer’s name (1 to 120 characters).')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="referral-edit-mobile" name={RFIELD.mobile} label="Mobile" optional type="tel" inputMode="tel" value={v.mobile} onChange={set('mobile')} maxLength={14} error={quoteProblem(state, RFIELD.mobile, 'Type a 10-digit Indian mobile number starting with 6, 7, 8 or 9.')} />
          <TextField id="referral-edit-email" name={RFIELD.email} label="Email" optional type="email" inputMode="email" value={v.email} onChange={set('email')} maxLength={REFERRAL_TEXT_LIMITS.email} error={quoteProblem(state, RFIELD.email, 'Type a full email address, or leave it empty.')} />
        </div>
        <TextField id="referral-edit-company" name={RFIELD.companyName} label="Company" optional value={v.companyName} onChange={set('companyName')} maxLength={REFERRAL_TEXT_LIMITS.companyName} error={quoteProblem(state, RFIELD.companyName, 'Up to 200 characters.')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="referral-edit-source"
            name={RFIELD.sourceKind}
            label="How did they reach us?"
            optional
            value={v.sourceKind}
            onChange={set('sourceKind')}
            options={[{ value: '', label: 'Not recorded' }, ...Object.entries(REFERRAL_SOURCE_LABEL).map(([value, label]) => ({ value, label }))]}
            error={quoteProblem(state, RFIELD.sourceKind, 'Choose one of the listed ways.')}
          />
          <TextField id="referral-edit-source-note" name={RFIELD.sourceNote} label="Who referred them?" optional value={v.sourceNote} onChange={set('sourceNote')} maxLength={REFERRAL_TEXT_LIMITS.sourceNote} error={quoteProblem(state, RFIELD.sourceNote, 'Up to 200 characters.')} />
        </div>
        <div>
          <Button type="submit" variant="secondary" size="lg" loading={pending} disabled={pending} className="min-h-11">
            {pending ? 'Saving…' : 'Save customer details'}
          </Button>
        </div>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Close / Reopen / Change owner (DA-72, DA-75, DA-76)
// ---------------------------------------------------------------------------

export function CloseDraftForm({ draftId, rowVersion, action }: { draftId: string; rowVersion: number; action: QuoteAction }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [state, formAction, pending] = useQuoteAction(announcing(action), { onSuccess: () => setOpen(false) });
  const reasonError = quoteProblem(state, RFIELD.reason, 'Choose why you are closing it.');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="lg" className="min-h-11">
          <Archive aria-hidden="true" />
          Close draft
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel="Close without closing the draft">
        <form noValidate aria-label="Close draft" onSubmit={postByHand(formAction)}>
          <DialogHeader>
            <DialogTitle>Close this draft?</DialogTitle>
            <DialogDescription>Closed drafts stay readable and can be reopened. Nothing is deleted.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <QuoteResultBox
              result={state}
              fields={[
                { field: RFIELD.reason, id: 'referral-close-reason', label: 'Why you are closing it' },
                { field: RFIELD.note, id: 'referral-close-note', label: 'Note: up to 500 characters' },
              ]}
            />
            {rowVersionInputs(draftId, rowVersion)}
            <ChoiceGroup id="referral-close-reason" legend="Why are you closing it?" error={reasonError ?? undefined}>
              {REFERRAL_MANUAL_CLOSE_REASONS.map((r) => (
                <Radio key={r} id={`referral-close-${r}`} name={RFIELD.reason} value={r} checked={reason === r} onChange={() => setReason(r)} invalid={Boolean(reasonError)} label={REFERRAL_CLOSE_REASON_LABEL[r]} />
              ))}
            </ChoiceGroup>
            <AreaField id="referral-close-note" name={RFIELD.note} label="Note" optional value={note} onChange={setNote} maxLength={REFERRAL_TEXT_LIMITS.closeNoteMax} error={quoteProblem(state, RFIELD.note, 'Up to 500 characters.')} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending} className="min-h-11">
              {pending ? 'Closing…' : 'Close draft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Reopen draft" (DA-75): the closed page's one primary. A note is required when it was closed as a duplicate. */
export function ReopenDraftForm({ draftId, rowVersion, noteRequired, action }: { draftId: string; rowVersion: number; noteRequired: boolean; action: QuoteAction }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [state, formAction, pending] = useQuoteAction(announcing(action), { onSuccess: () => setOpen(false) });
  return (
    <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="primary" size="lg" className="min-h-11">
            <RotateCcw aria-hidden="true" />
            Reopen draft
          </Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close without reopening">
          <form noValidate aria-label="Reopen draft" onSubmit={postByHand(formAction)}>
            <DialogHeader>
              <DialogTitle>Reopen this draft?</DialogTitle>
              <DialogDescription>It can be changed again, with its quotations and itineraries. The 90 days without activity start again.</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <QuoteResultBox result={state} fields={[{ field: RFIELD.note, id: 'referral-reopen-note', label: 'Why you are reopening it' }]} />
              {rowVersionInputs(draftId, rowVersion)}
              <AreaField
                id="referral-reopen-note"
                name={RFIELD.note}
                label="Why are you reopening it?"
                optional={!noteRequired}
                hint={noteRequired ? 'Needed because it was closed as a duplicate. Saved with your name.' : 'Saved with your name.'}
                value={note}
                onChange={setNote}
                maxLength={REFERRAL_TEXT_LIMITS.closeNoteMax}
                error={quoteProblem(state, RFIELD.note, noteRequired ? 'Say why it is not a duplicate (up to 500 characters).' : 'Up to 500 characters.')}
              />
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending} className="min-h-11">
                {pending ? 'Reopening…' : 'Reopen draft'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "Change owner" (DA-76, branch Manager): new owner from Sales in the branch, reason 10–500. */
export function ChangeOwnerForm({
  draftId,
  rowVersion,
  branchName,
  candidates,
  action,
}: {
  draftId: string;
  rowVersion: number;
  branchName: string;
  candidates: Array<{ userId: string; displayName: string }>;
  action: QuoteAction;
}) {
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useQuoteAction(announcing(action), { onSuccess: () => setOpen(false) });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="lg" className="min-h-11">
          <UserRoundPen aria-hidden="true" />
          Change owner
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel="Close without changing the owner">
        <form noValidate aria-label="Change owner" onSubmit={postByHand(formAction)}>
          <DialogHeader>
            <DialogTitle>Change the owner of this draft</DialogTitle>
            <DialogDescription>New owner must work in Sales in {branchName}.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <QuoteResultBox
              result={state}
              fields={[
                { field: RFIELD.newOwner, id: 'referral-owner', label: 'New owner' },
                { field: RFIELD.reason, id: 'referral-owner-reason', label: `Reason: ${NOTE_RULE}` },
              ]}
            />
            {rowVersionInputs(draftId, rowVersion)}
            <SelectField
              id="referral-owner"
              name={RFIELD.newOwner}
              label="New owner"
              value={owner}
              onChange={setOwner}
              options={[{ value: '', label: 'Choose a person' }, ...candidates.map((c) => ({ value: c.userId, label: c.displayName }))]}
              error={quoteProblem(state, RFIELD.newOwner, `Choose someone who works in Sales in ${branchName}.`)}
            />
            <AreaField
              id="referral-owner-reason"
              name={RFIELD.reason}
              label="Why are you changing the owner?"
              hint={NOTE_RULE}
              value={reason}
              onChange={setReason}
              maxLength={REFERRAL_TEXT_LIMITS.reasonMax}
              error={quoteProblem(state, RFIELD.reason, `Write ${NOTE_RULE.split(',')[0]}.`)}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="lg" loading={pending} disabled={pending} className="min-h-11">
              {pending ? 'Changing…' : 'Change owner'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Link to Bitrix (DA-61..DA-65; G11)
// ---------------------------------------------------------------------------

/**
 * Candidate list with no preselection. "Link to {ref}" opens the DA-63
 * confirmation; only "Link" in that dialog posts. A refusal keeps the choice
 * and shows the DA-65 reason; the typed note stays.
 */
export function ReferralLinkForm({ draftId, rowVersion, step, action }: { draftId: string; rowVersion: number; step: ReferralLinkStepVM; action: QuoteAction }) {
  const [chosen, setChosen] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [state, formAction, pending] = useQuoteAction(announcing(action));
  const candidate = step.candidates.find((c) => c.id === chosen) ?? null;
  const error = missing && !candidate ? `Choose the ${step.kind} to link first.` : quoteProblem(state, RFIELD.targetId, `Choose a ${step.kind} from the list.`);
  const confirmText = candidate ? step.confirmTemplate.replaceAll('{ref}', candidate.reference) : '';
  return (
    <form ref={formRef} noValidate aria-label={`Link to a Bitrix ${step.kind}`} onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-4">
      <QuoteResultBox result={state} fields={[{ field: RFIELD.targetId, id: 'referral-link-candidates', label: `The ${step.kind} to link` }]} successText={null} />
      {rowVersionInputs(draftId, rowVersion)}
      <input type="hidden" name={RFIELD.targetKind} value={step.kind} />
      <ChoiceGroup id="referral-link-candidates" legend={step.heading} hint="Nothing is chosen for you." error={error ?? undefined}>
        {step.candidates.map((c) => (
          <Radio
            key={c.id}
            id={`referral-link-${c.id}`}
            name={RFIELD.targetId}
            value={c.id}
            checked={chosen === c.id}
            onChange={() => {
              setChosen(c.id);
              setMissing(false);
            }}
            disabled={!c.linkable}
            invalid={Boolean(error)}
            label={`${c.reference} · ${c.title}`}
            // A disabled row says why once: the refusal replaces the flag that causes it.
            description={(c.linkable || !c.refusedText ? [c.branchName, ...c.flags] : [c.branchName, c.refusedText]).join(' · ')}
          />
        ))}
      </ChoiceGroup>
      <AreaField id="referral-link-note" name={RFIELD.note} label="Note" optional value={note} onChange={setNote} maxLength={REFERRAL_TEXT_LIMITS.closeNoteMax} hint="Saved with your name in History." />
      <div>
        <Button
          ref={triggerRef}
          type="button"
          variant="primary"
          size="lg"
          loading={pending}
          disabled={pending}
          className="h-auto min-h-11 py-2 whitespace-normal"
          onClick={() => {
            if (!candidate) {
              setMissing(true);
              const first = step.candidates.find((c) => c.linkable);
              if (first) document.getElementById(`referral-link-${first.id}`)?.focus();
              return;
            }
            setOpen(true);
          }}
        >
          <Link2 aria-hidden="true" />
          {pending ? 'Linking…' : candidate ? `Link to ${candidate.reference}` : `Link to the chosen ${step.kind}`}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* No DialogTrigger (the button first checks a choice): focus returns to it by hand (Echo-B L3). */}
        <DialogContent
          closeLabel="Close without linking"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Link this draft to {candidate?.reference}?</DialogTitle>
            <DialogDescription>{confirmText}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="min-h-11"
              onClick={() => {
                // The dialog is portalled outside the form: post the form's own fields, then show the
                // answer (success or the DA-65 refusal) in the form, where the choice is still made.
                const form = formRef.current;
                if (!form) return;
                const fd = new FormData(form);
                setOpen(false);
                startTransition(() => formAction(fd));
              }}
            >
              Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** "Remove this link" (DA-66..DA-69): reason, note 10–500, confirmation. */
export function ReferralUnlinkForm({ link, draftId, rowVersion, action }: { link: ReferralLinkVM; draftId: string; rowVersion: number; action: QuoteAction }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [state, formAction, pending] = useQuoteAction(announcing(action), { onSuccess: () => setOpen(false) });
  const reasonError = quoteProblem(state, RFIELD.reason, 'Choose why you are removing the link.');
  const base = `referral-unlink-${link.linkId}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="secondary" size="sm" className="max-sm:h-11 self-start">
            <Unlink aria-hidden="true" />
            Remove this link
            <span className="sr-only"> to {link.reference}</span>
          </Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close without removing the link">
          <form noValidate aria-label={`Remove the link to ${link.reference}`} onSubmit={postByHand(formAction)}>
            <DialogHeader>
              <DialogTitle>Remove the link to {link.reference}?</DialogTitle>
              <DialogDescription>Sales on {link.reference} lose access to this draft at once. The link stays in History.</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <QuoteResultBox
                result={state}
                fields={[
                  { field: RFIELD.reason, id: `${base}-reason`, label: 'Why you are removing the link' },
                  { field: RFIELD.note, id: `${base}-note`, label: `Note: ${NOTE_RULE}` },
                ]}
              />
              <input type="hidden" name={RFIELD.linkId} value={link.linkId} />
              {/* The action redirects back to the Link tab with the result (Terra fix round, Echo-B M1). */}
              <input type="hidden" name={RFIELD.draftId} value={draftId} />
              <input type="hidden" name={RFIELD.rowVersion} value={String(rowVersion)} />
              <ChoiceGroup id={`${base}-reason`} legend="Why are you removing the link?" error={reasonError ?? undefined}>
                {REFERRAL_UNLINK_REASONS.map((r) => (
                  <Radio key={r} id={`${base}-${r}`} name={RFIELD.reason} value={r} checked={reason === r} onChange={() => setReason(r)} invalid={Boolean(reasonError)} label={REFERRAL_UNLINK_REASON_LABEL[r]} />
                ))}
              </ChoiceGroup>
              <AreaField
                id={`${base}-note`}
                name={RFIELD.note}
                label="Note"
                hint={NOTE_RULE}
                value={note}
                onChange={setNote}
                maxLength={REFERRAL_TEXT_LIMITS.reasonMax}
                error={quoteProblem(state, RFIELD.note, `Write ${NOTE_RULE.split(',')[0]}.`)}
              />
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" size="lg" loading={pending} disabled={pending} className="min-h-11">
                {pending ? 'Removing…' : 'Remove link'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
