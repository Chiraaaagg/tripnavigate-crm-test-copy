import type { BookingActionResult } from '@/modules/fulfilment/contracts';

/*
 * Batch 4 (23 October 2026): the one-click workflow switch form that lived
 * here (radios in a plain `<form action>`, "Save this switch") is replaced by
 * the Settings change flow in `settings/setting-switch-form.tsx` (DA-256:
 * choose, reason, review, confirm, on the shared HandForm). Only the action
 * type is kept for callers that still name it.
 */

/** A server action in the frozen shape `(prev, FormData) => BookingActionResult`. */
export type WorkflowAction = (prev: never, formData: FormData) => Promise<BookingActionResult<unknown>>;
