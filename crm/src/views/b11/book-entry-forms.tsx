'use client';

import { useState } from 'react';
import { newRequestId, PendingButton, ResultBox, useB11Action, type UiResult } from './form-kit';
import type { B11Action } from './shapes';

/*
 * The two buttons that open a draft: "Book now" (first draft of the Deal) and
 * "Fix and send again" (revision of a booking Accounts returned). Each is a
 * small form so it works before script loads; on success the browser moves
 * to the first step of the form.
 */

export function StartBookNowForm({
  dealId,
  action,
  continueHref,
  initialState = null,
  label = 'Book now',
}: {
  dealId: string;
  action: B11Action;
  continueHref: string;
  initialState?: UiResult | null;
  label?: string;
}) {
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action, { initialState, continueHref, savedText: 'Booking draft started. Nothing has been booked or paid.' });
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <ResultBox result={state && !state.ok ? state : null} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="intent" value="continue" />
      <div>
        <PendingButton pendingLabel="Starting…" variant="primary">
          {label}
        </PendingButton>
      </div>
    </form>
  );
}

export function FixBookingForm({
  dealId,
  baseVersionId,
  action,
  continueHref,
  initialState = null,
}: {
  dealId: string;
  baseVersionId: string;
  action: B11Action;
  continueHref: string;
  initialState?: UiResult | null;
}) {
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action, { initialState, continueHref, savedText: 'Fix started. Change what Accounts asked for, then save the fixed booking.' });
  return (
    <form action={formAction} noValidate className="flex flex-col gap-3">
      <ResultBox result={state && !state.ok ? state : null} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="baseVersionId" value={baseVersionId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="intent" value="continue" />
      <div>
        <PendingButton pendingLabel="Opening…" variant="primary">
          Fix and send again
        </PendingButton>
      </div>
    </form>
  );
}
