'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { useHandFormStatus } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { ErrorSummary, type ErrorSummaryItem } from '@/components/ui/error-summary';
import { Notice } from '@/components/ui/notice';
import { BOOK_NOW_TEXT, ERROR_TEXT, ISSUE_TEXT, UNKNOWN_OUTCOME_TEXT, type BookingActionResult, type BookingIssueCode } from '@/modules/fulfilment/contracts';
import { guard, type UiResult } from '../booking-forms';
import { normaliseResult } from './result';
import type { B11Action } from './shapes';

export { normaliseResult };

/*
 * Small client helpers shared by every B1.1 form: the action wrapper (typed
 * values stay in the controlled inputs whatever the answer), the refusal box
 * with links to the named fields, the "who saved it first" conflict text,
 * the pending submit button, a fresh request id per attempt, the
 * after-save navigation and the unsaved-changes guard.
 */

export type { UiResult };

/** Extra words for refusal codes that B1 does not know yet (B1.1 tokens). */
export const B11_ERROR_TEXT: Record<string, string> = {
  billing_verified: 'Accounts has already verified the billing details, so they cannot be changed here. Ask Accounts to change them. Nothing else was saved.',
  version_superseded: 'This booking version has been replaced by a newer one. Reload to see the current version.',
  revision_not_allowed: 'This booking can only be fixed after Accounts returns it. If Accounts has since approved it, discard your changes or ask Accounts to return it.',
  already_committed: 'Part of this booking is already booked with a supplier or the visa work is finished. Changes after that are not supported yet. Talk to your manager, the department and Accounts.',
  classification_not_allowed: 'This change cannot be marked as a spelling or format fix. Changes to dates, services, travellers, price or plan need the customer to accept again.',
  revision_items_fixed: 'While fixing a returned booking you can change services but not add or remove them.',
  documents_not_checked: 'All required documents must be checked before the application is marked submitted.',
  outcome_document_required: 'Upload the authority’s document (approval or refusal letter) first. A fee receipt or reference never proves the outcome.',
  outcome_required: 'Record the authority’s outcome first.',
  application_closed: 'This application is already closed.',
  task_closed: 'This task is already closed.',
  cost_locked: 'This cost was already sent to Accounts. Wait for Accounts to accept or return it.',
  receipt_required: 'Upload the payment receipt before sending this cost to Accounts.',
  direct_payment_over_limit: 'Above ₹50,000 per purchase, a company payment goes through a supplier payment request. Record it as “Not yet”.',
  duplicate_claim: 'This payment reference is already reported on this deal. Check the payments listed below before reporting it again.',
  claim_over_total: 'The amount is more than the final selling total. Check the amount or the total.',
  receipt_already_linked: 'That receipt already backs another claim. One receipt can back only one claim.',
  wrong_state: 'This was already handled by someone else. Reload the page.',
  not_self_approval: 'You reported or recorded this yourself, or you sell this deal, so another Accounts person must handle it.',
  request_conflict: 'This request was already used for different details. Reload the page and try again.',
};

export function errorText(result: Extract<UiResult, { ok: false }>): string {
  if (result.message) return result.message;
  if (result.code === 'unexpected') return UNKNOWN_OUTCOME_TEXT;
  return B11_ERROR_TEXT[result.code] ?? (ERROR_TEXT as Record<string, string>)[result.code] ?? UNKNOWN_OUTCOME_TEXT;
}

/** Field names the server named in a refusal (none for an unexpected failure). */
export function refusedFields(result: UiResult | null): string[] | undefined {
  if (!result || result.ok) return undefined;
  return 'fields' in result ? result.fields : undefined;
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

const SAVED_FLAG = 'tn-b11-saved';

/** Remember "saved" across the move to the next step, so the next page can announce it. */
function rememberSaved(text: string) {
  try {
    sessionStorage.setItem(SAVED_FLAG, text);
  } catch {
    // Storage blocked: the next page simply does not announce it.
  }
}

/**
 * Wraps a frozen action: keeps the last answer, knows which button was
 * pressed (`intent`), and on success either stays (the page data refreshes)
 * or moves to `continueHref`.
 */
export function useB11Action(
  action: B11Action,
  options: { initialState?: UiResult | null; continueHref?: string | null; savedText?: string; onSuccess?: () => void } = {},
) {
  const router = useRouter();
  const [state, formAction] = useActionState(async (prev: UiResult | null, formData: FormData) => {
    const intent = formData.get('intent');
    const result = normaliseResult(await guard(action as (prev: never, fd: FormData) => Promise<BookingActionResult<unknown>>)(prev, formData));
    if (result.ok) {
      options.onSuccess?.();
      if (intent === 'continue' && options.continueHref) {
        rememberSaved(options.savedText ?? result.message);
        router.push(options.continueHref);
      } else {
        router.refresh();
      }
    }
    return result;
  }, options.initialState ?? null);
  return [state, formAction] as const;
}

export function PendingButton({
  children,
  pendingLabel,
  variant = 'secondary',
  name,
  value,
  disabled,
  className,
  describedBy,
}: {
  children: ReactNode;
  pendingLabel: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}) {
  const { pending, data } = useHandFormStatus();
  const mine = pending && (!name || data?.get(name) === value);
  return (
    <Button
      type="submit"
      name={name}
      value={value}
      variant={variant}
      size="lg"
      loading={mine}
      disabled={disabled || pending}
      aria-describedby={describedBy}
      className={cn('h-auto min-h-11 py-2 whitespace-normal', className)}
    >
      {mine ? pendingLabel : children}
    </Button>
  );
}

export interface FieldRef {
  /** Server field name (as in `fields` of a refusal). */
  field: string;
  /** Element id to jump to. */
  id: string;
  label: string;
}

/**
 * Answer of the last attempt: an alert box with the reason and links to the
 * named fields, or a polite "saved" line. `conflict` names who saved first.
 */
export function ResultBox({
  result,
  fields = [],
  reloadHref,
  successText,
  className,
}: {
  result: UiResult | null;
  fields?: FieldRef[];
  /** For "someone saved first": reloading shows their version and drops what is typed here. */
  reloadHref?: string;
  successText?: string;
  className?: string;
}) {
  if (result && !result.ok) {
    const named = (refusedFields(result) ?? [])
      .map((f) => fields.find((x) => x.field === f))
      .filter((x): x is FieldRef => Boolean(x))
      .map<ErrorSummaryItem>((x) => ({ fieldId: x.id, text: x.label }));
    const conflict = 'conflict' in result ? result.conflict : undefined;
    const conflictText =
      result.code === 'version_changed'
        ? conflict
          ? BOOK_NOW_TEXT.conflict
              .replace('{name}', conflict.savedByName ?? 'Someone else')
              .replace('{time}', new Date(conflict.savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }))
          : BOOK_NOW_TEXT.conflictUnknown
        : null;
    return (
      <ErrorSummary
        className={className}
        title={conflictText ?? errorText(result)}
        description={named.length > 0 ? 'Check the fields marked below. What you typed is still here.' : conflictText ? undefined : 'What you typed is still here.'}
        items={named}
      >
        {result.issues && result.issues.length > 0 ? (
          <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
            {result.issues.map((code) => (
              <li key={code}>{ISSUE_TEXT[code as BookingIssueCode] ?? code}</li>
            ))}
          </ul>
        ) : null}
        {conflictText && reloadHref ? (
          <p className="m-0 mt-1.5">
            <a href={reloadHref} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
              Load the latest version (replaces what you typed)
            </a>
          </p>
        ) : null}
      </ErrorSummary>
    );
  }
  if (result?.ok) {
    return (
      <Notice tone="success" role="status" className={className}>
        {successText ?? result.message}
      </Notice>
    );
  }
  return <div role="status" aria-live="polite" className={className} />;
}

/** On the next step: announce "Saved …" once, if the previous step saved and moved here. */
export function SavedAnnouncer({ headingId }: { headingId: string }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let text: string | null = null;
    try {
      text = sessionStorage.getItem(SAVED_FLAG);
      if (text) sessionStorage.removeItem(SAVED_FLAG);
    } catch {
      text = null;
    }
    if (text && region.current) {
      region.current.textContent = text;
      region.current.className =
        'mb-4 rounded-control border border-status-success-line bg-status-success-tint px-3.5 py-3 font-sans text-base text-copy';
      document.getElementById(headingId)?.focus();
    }
  }, [headingId]);
  return <div ref={region} role="status" aria-live="polite" />;
}

/**
 * Warn before leaving a step with unsaved typed values: on page unload, and on
 * clicks on in-app links (native confirm, no custom modal).
 */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!link || link.getAttribute('href')?.startsWith('#')) return;
      if (!window.confirm('You have unsaved changes. Leave this page without saving them?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}

/** Tracks whether controlled values differ from what was loaded. */
export function useDirty<T>(initial: T, current: T): boolean {
  const [base] = useState(() => JSON.stringify(initial));
  return JSON.stringify(current) !== base;
}

/** The standard footer of a step: Back, Save draft, Save and continue. */
export function StepFooter({
  backHref,
  continueLabel,
  canContinue = true,
  editable,
  dirty,
}: {
  backHref: string | null;
  continueLabel: string | null;
  canContinue?: boolean;
  editable: boolean;
  dirty: boolean;
}) {
  return (
    <div className="mt-2.5 flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        {backHref ? (
          <a href={backHref} className={cn('inline-flex min-h-11 items-center rounded-control px-1 font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Back
          </a>
        ) : null}
        <span className="text-sm text-quiet" aria-live="polite">
          {!editable ? 'Read only for you.' : dirty ? 'Unsaved changes on this step.' : 'No unsaved changes.'}
        </span>
      </div>
      {editable ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <PendingButton name="intent" value="save" pendingLabel="Saving…" variant="secondary">
            Save draft
          </PendingButton>
          {continueLabel ? (
            <PendingButton name="intent" value="continue" pendingLabel="Saving…" variant="primary" disabled={!canContinue}>
              {continueLabel}
            </PendingButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
