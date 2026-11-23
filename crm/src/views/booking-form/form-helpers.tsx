'use client';

import { useState, type FormEvent } from 'react';
import { BaseRowVersion } from '../b11/draft-sync';
import { newRequestId, refusedFields, type FieldRef, type UiResult } from '../b11/form-kit';
import { Button } from '@/components/ui/button';
import { problemFor } from '../b11/controls';
import type { BookNowView } from '../b11/shapes';

/*
 * Shared pieces of the booking form's section forms: the hidden inputs every
 * draft form posts, the quiet save row (shown only when the section has
 * unsaved changes, so the clean page matches the approved preview), and the
 * refused-field lookup.
 */

export function HiddenDraftInputs({
  view,
  base,
  extra,
  result,
}: {
  view: BookNowView;
  base: number;
  extra?: Record<string, string | number | null | undefined>;
  /** The section's last reply: a new request id follows every reply (Echo B-H1). */
  result: UiResult | null;
}) {
  const requestId = useRequestId(result);
  return (
    <>
      <input type="hidden" name="dealId" value={view.dealId} />
      <input type="hidden" name="versionId" value={view.version?.versionId ?? ''} />
      <BaseRowVersion base={base} />
      <input type="hidden" name="requestId" value={requestId} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v ?? ''} />
      ))}
    </>
  );
}

/** "Save …" plus "Not saved yet" under a section, only while it has unsaved changes. */
export function SectionSaveRow({ label, dirty, editable, pending = false }: { label: string; dirty: boolean; editable: boolean; pending?: boolean }) {
  if (!editable || !dirty) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" size="lg" loading={pending} className="h-auto min-h-10 py-2 text-base whitespace-normal">
        {pending ? 'Saving…' : label}
      </Button>
      <span className="text-sm text-quiet">Not saved yet</span>
    </div>
  );
}

/** Error text of a refused field (Mercury A wording is in the refs' labels). */
export function errFor(refs: readonly FieldRef[], fields: readonly string[] | undefined) {
  return (name: string) => problemFor(fields, name, refs.find((r) => r.field === name)?.label ?? 'Check this field.');
}

export const editableOf = (view: BookNowView) => view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;

/**
 * One request id per submission (Echo B-H1): the database replays a request id
 * only for the same payload, so every reply that reached it (a save or a
 * refusal) gets a fresh id for the next submission. Only an unknown outcome
 * keeps the id, so an exact retry is answered from the replay.
 */
export function useRequestId(result: UiResult | null): string {
  const [id, setId] = useState(() => newRequestId());
  const [seen, setSeen] = useState(result);
  if (result !== seen) {
    setSeen(result);
    if (result && (result.ok || result.code !== 'unexpected')) setId(newRequestId());
  }
  return id;
}

/**
 * The refusal as it should show now (Echo B-M2, preview condition 29): a
 * named field whose value changed since the refusal is no longer listed or
 * marked; when every named field is corrected the box goes away. A refusal
 * that names no field stays until the next save.
 */
export function useShownRefusal<T>(f: { state: UiResult | null; refusedValues: T | null; values: T }, pick: (field: string) => ((v: T) => unknown) | undefined): { shown: UiResult | null; fields: string[] | undefined } {
  const state = f.state;
  if (!state || state.ok) return { shown: state, fields: undefined };
  const named = refusedFields(state) ?? [];
  if (named.length === 0 || !f.refusedValues) return { shown: state, fields: named.length ? named : undefined };
  const refused = f.refusedValues;
  const still = named.filter((name) => {
    const sel = pick(name);
    return !sel || JSON.stringify(sel(f.values)) === JSON.stringify(sel(refused));
  });
  if (still.length === 0) return { shown: null, fields: undefined };
  return { shown: { ...state, fields: still } as UiResult, fields: still };
}

/**
 * Submits a section form through the section's own post (not the form's
 * `action` prop). React resets a form after an action completes, which puts
 * every controlled <select> back to its first option in the page while the
 * state still holds the chosen value, so the next save would post "Choose".
 * Submitting by hand keeps the fields exactly as typed.
 */
export function useSectionSubmit(post: (fd: FormData) => Promise<UiResult>) {
  const [pending, setPending] = useState(false);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    setPending(true);
    void post(fd).finally(() => setPending(false));
  };
  return { onSubmit, pending };
}
