'use client';

import { useRouter } from 'next/navigation';
import { useActionState, type ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { ErrorSummary, type ErrorSummaryItem } from '@/components/ui/error-summary';
import { Notice } from '@/components/ui/notice';
import { QUOTATION_ISSUE_TEXT, type QuotationActionResult, type QuotationChecklistCode } from '@/modules/quotations/contracts';
import { guard } from '../booking-forms';
import type { UiResult } from '../b11/form-kit';
import type { B11Action } from '../b11/shapes';

/*
 * Client helpers shared by the quotation forms (B1.2 Phase E): the action
 * type, a wrapper that keeps typed values whatever the answer (an unexpected
 * throw becomes an honest in-form error), and the answer box with the frozen
 * quotation wording, links to the named fields and the blocking issues.
 */

/** Every quotation action: (prev, FormData) → QuotationActionResult (Terra, modules/quotations/server). */
export type QuoteAction = (prev: never, formData: FormData) => Promise<QuotationActionResult<unknown>>;

export interface QuoteActions {
  create: QuoteAction;
  saveDetails: QuoteAction;
  saveContact: QuoteAction;
  saveContent: QuoteAction;
  saveTiers: QuoteAction;
  saveItem: QuoteAction;
  removeItem: QuoteAction;
  markReady: QuoteAction;
  markSent: QuoteAction;
  uploadEvidence: QuoteAction;
  removeEvidence: QuoteAction;
  accept: QuoteAction;
  decline: QuoteAction;
  newVersion: QuoteAction;
  discard: QuoteAction;
  linkDeal: QuoteAction;
  convert: QuoteAction;
  saveLines: QuoteAction;
  saveTierTotal: QuoteAction;
  savePlan: QuoteAction;
  saveCostEstimates: QuoteAction;
  /** B1.2 Bitrix prefill (0600): use Bitrix values, mark checked (booking-shaped results). */
  usePrefill?: B11Action;
  markPrefillChecked?: B11Action;
  /** Batch 2 (prefill_fill_empty): "Fill empty fields from Bitrix" (inline mode only). */
  fillEmptyPrefill?: B11Action;
  /** Batch 2 (prefill_notice_dismiss): "Keep mine" on a "Bitrix now says …" notice (inline mode only). */
  dismissPrefillNotice?: B11Action;
}

/** The booking section-form hook takes the B1.1 action type; quotation results have the same ok/data/fields shape. */
export function asSyncAction(action: QuoteAction): B11Action {
  return action as unknown as B11Action;
}

export type QuoteResult = QuotationActionResult<unknown> | { ok: false; code: 'unexpected'; message: string; fields?: undefined; issues?: undefined };

/** Data of a successful answer (typed by the caller; the actions document their result shapes). */
export function dataOf<T>(result: QuoteResult | UiResult | null): T | null {
  return result && result.ok ? ((result as { data: unknown }).data as T) : null;
}

/**
 * Wraps one quotation action for a single form: on success the page data
 * refreshes, or the browser moves to the address `goTo` names.
 */
export function useQuoteAction(action: QuoteAction, options: { goTo?: (data: unknown) => string | null; onSuccess?: (data: unknown) => void } = {}) {
  const router = useRouter();
  return useActionState(async (prev: QuoteResult | null, formData: FormData): Promise<QuoteResult> => {
    const result = (await guard(action as unknown as (prev: never, fd: FormData) => Promise<never>)(prev as never, formData)) as unknown as QuoteResult;
    if (result.ok) {
      options.onSuccess?.(result.data);
      const href = options.goTo?.(result.data) ?? null;
      if (href) router.push(href);
      else router.refresh();
    }
    return result;
  }, null);
}

export interface QuoteFieldRef {
  field: string;
  id: string;
  label: string;
}

export function quoteFieldsOf(result: QuoteResult | UiResult | null): string[] | undefined {
  if (!result || result.ok) return undefined;
  return 'fields' in result ? result.fields : undefined;
}

/** Field error for a refused field name. */
export function quoteProblem(result: QuoteResult | UiResult | null, name: string, text: string): string | null {
  if (!quoteFieldsOf(result)?.includes(name)) return null;
  return result && !result.ok && result.code === 'internal_wording' ? INTERNAL_WORDING_FIELD_TEXT : text;
}

/** Field text for customer text refused for internal words (net rate, margin, supplier…). */
export const INTERNAL_WORDING_FIELD_TEXT = 'Not saved: remove internal words like net rate, margin, cost or supplier.';

function itemLabel(result: QuoteResult | UiResult, label: string): string {
  if (result.ok || result.code !== 'internal_wording') return label;
  const base = label.split(':')[0]!.replace(/\s*\(.*\)$/, '');
  return `${base}: contains internal words`;
}

/**
 * The answer of the last attempt: an alert with the plain reason, links to
 * the named fields and the blocking issues, or a polite success line.
 */
export function QuoteResultBox({
  result,
  fields = [],
  reloadHref,
  successText,
  className,
  children,
}: {
  result: QuoteResult | UiResult | null;
  fields?: QuoteFieldRef[];
  reloadHref?: string;
  successText?: string | null;
  className?: string;
  /** Extra content under a refusal (for example a link to the existing booking draft). */
  children?: ReactNode;
}) {
  if (result && !result.ok) {
    const named = (quoteFieldsOf(result) ?? [])
      .map((f) => fields.find((x) => x.field === f))
      .filter((x): x is QuoteFieldRef => Boolean(x))
      .map<ErrorSummaryItem>((x) => ({ fieldId: x.id, text: itemLabel(result, x.label) }));
    const issues = ('issues' in result ? (result.issues as QuotationChecklistCode[] | undefined) : undefined) ?? [];
    return (
      <ErrorSummary
        className={className}
        title={result.message || 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.'}
        description={named.length > 0 ? 'Check the fields marked below. What you typed is still here.' : 'What you typed is still here.'}
        items={named}
      >
        {issues.length > 0 ? (
          <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
            {issues.map((code) => (
              <li key={code}>
                <a href={`#${QUOTATION_ISSUE_TEXT[code]?.section ?? 'details'}`} className={cn('rounded-chip font-medium text-status-danger underline underline-offset-4', focusRing)}>
                  {QUOTATION_ISSUE_TEXT[code]?.text ?? code}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {result.code === 'version_changed' && reloadHref ? (
          <p className="m-0 mt-1.5">
            <a href={reloadHref} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
              Load the latest version (replaces what you typed)
            </a>
          </p>
        ) : null}
        {children}
      </ErrorSummary>
    );
  }
  if (result?.ok && successText !== null) {
    return (
      <Notice tone="success" role="status" className={className}>
        {successText ?? result.message}
      </Notice>
    );
  }
  return <div role="status" aria-live="polite" className={className} />;
}
