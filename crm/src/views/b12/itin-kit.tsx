'use client';

import type { ReactNode } from 'react';
import { ITINERARY_READINESS_TEXT, SOURCE_MAX_BYTES, SOURCE_MIMES, type ItineraryActionResult, type ItineraryReadinessCode } from '@/modules/itineraries/contracts';
import type { B11Action } from '../b11/shapes';
import { QuoteResultBox, type QuoteAction, type QuoteFieldRef, type QuoteResult } from './quote-kit';

/*
 * Client helpers for the itinerary screens (B1.2 Phase F): the action type
 * (Terra, modules/itineraries/server/actions.ts) and the answer box. The
 * itinerary results have the same ok/data/fields shape as the quotation
 * ones; readiness issues and document blocks are listed in words.
 */

export type ItinAction = (prev: never, formData: FormData) => Promise<ItineraryActionResult<unknown>>;

export interface ItinActions {
  create: ItinAction;
  uploadSource: ItinAction;
  removeSource: ItinAction;
  saveFacts: ItinAction;
  checkDifferences: ItinAction;
  useBasisValue: ItinAction;
  acknowledge: ItinAction;
  markReady: ItinAction;
  requestRender: ItinAction;
}

export const asQuoteAction = (a: ItinAction) => a as unknown as QuoteAction;
export const asItinSyncAction = (a: ItinAction) => a as unknown as B11Action;

type AnyResult = QuoteResult | ItineraryActionResult<unknown> | { ok: boolean } | null;

export function ItinResultBox({ result, fields, reloadHref, successText, className, children }: { result: AnyResult; fields?: QuoteFieldRef[]; reloadHref?: string; successText?: string | null; className?: string; children?: ReactNode }) {
  const r = result as (ItineraryActionResult<unknown> & { issues?: ItineraryReadinessCode[]; blocks?: string[] }) | null;
  const issues = r && !r.ok ? (r.issues ?? []) : [];
  const blocks = r && !r.ok ? (r.blocks ?? []) : [];
  // The quotation box knows the quotation issue codes only; itinerary readiness issues and blocks are listed here.
  const plain = r && !r.ok ? ({ ...r, issues: undefined } as unknown as QuoteResult) : (r as unknown as QuoteResult | null);
  return (
    <QuoteResultBox result={plain} fields={fields} reloadHref={reloadHref} successText={successText} className={className}>
      {issues.length > 0 || blocks.length > 0 ? (
        <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
          {issues.map((code) => (
            <li key={code}>{ITINERARY_READINESS_TEXT[code] ?? code}</li>
          ))}
          {blocks.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {children}
    </QuoteResultBox>
  );
}

/** Plain words for a source file the server would refuse; null when it may be sent. */
export function sourceFileProblem(file: { size: number; type: string; name: string }): string | null {
  if (!(SOURCE_MIMES as readonly string[]).includes(file.type)) return `${file.name} is not a PDF, Word (.docx), JPG, PNG or WebP file. Choose another file; nothing was uploaded.`;
  if (file.size > SOURCE_MAX_BYTES) return `${file.name} is larger than ${Math.floor(SOURCE_MAX_BYTES / (1024 * 1024))} MB. Choose a smaller file; nothing was uploaded.`;
  if (file.size === 0) return `${file.name} is empty. Choose another file; nothing was uploaded.`;
  return null;
}
