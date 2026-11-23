'use client';

import { useActionState } from 'react';
import { useKeepValuesOnFailure } from '@/views/keep-form-values';

/*
 * Local preview only (AUDIT-017 browser check). Two identical forms whose
 * action always refuses, like a server action answering "invalid input":
 * the first is a plain uncontrolled <form action>, which React 19 resets;
 * the second uses useKeepValuesOnFailure, as the Purchase forms do.
 */

type Result = { ok: false; message: string } | null;

async function refuse(): Promise<Result> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ok: false, message: 'Synthetic refusal: the price must be whole rupees and paise.' };
}

function Fields({ prefix }: { prefix: string }) {
  return (
    <>
      <label htmlFor={`${prefix}-hotel`}>Hotel offered</label>
      <input id={`${prefix}-hotel`} name="hotelName" defaultValue="Synthetic Lakeside Hotel" />
      <label htmlFor={`${prefix}-cost`}>Supplier price</label>
      <input id={`${prefix}-cost`} name="quotedCostRupees" />
      <label htmlFor={`${prefix}-meal`}>Meal plan</label>
      <select id={`${prefix}-meal`} name="mealPlan" defaultValue="EP">
        <option value="EP">Room only</option>
        <option value="CP">Breakfast</option>
      </select>
      <label htmlFor={`${prefix}-terms`}>Cancellation terms</label>
      <textarea id={`${prefix}-terms`} name="cancellationTerms" />
      <label>
        <input type="checkbox" name="serviceTypes" value="hotel" defaultChecked /> Hotel
      </label>
      <label>
        <input type="checkbox" name="serviceTypes" value="transfer" /> Transfer
      </label>
      <input type="hidden" name="requestId" value="00000000-0000-4000-8000-000000000001" />
    </>
  );
}

function PlainForm() {
  const [state, action] = useActionState(refuse, null);
  return (
    <form action={action} aria-label="Plain form" data-testid="plain">
      {state ? <p role="alert">{state.message}</p> : null}
      <Fields prefix="plain" />
      <button type="submit">Submit plain</button>
    </form>
  );
}

function KeptForm() {
  const [state, action] = useActionState(refuse, null);
  const keepValues = useKeepValuesOnFailure(state);
  return (
    <form onSubmit={keepValues} action={action} aria-label="Form that keeps values" data-testid="kept">
      {state ? <p role="alert">{state.message}</p> : null}
      <Fields prefix="kept" />
      <button type="submit">Submit kept</button>
    </form>
  );
}

export function KeepValuesProbe() {
  return (
    <main>
      <h1>Form values after a refused submit</h1>
      <PlainForm />
      <KeptForm />
    </main>
  );
}
