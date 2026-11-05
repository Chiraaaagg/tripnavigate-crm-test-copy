'use client';

import { useCallback, useRef } from 'react';
import { MoneyInput } from '@/components/ui/money-input';
import type { BookingFormServiceItemView, FlightFareTotals } from '@/modules/fulfilment/booking-form-contract';
import { formatInr, paiseToRupeesText, rupeesToPaise } from '@/modules/fulfilment/booking-form-model';
import type { BookTravellerView } from '@/modules/fulfilment/contracts';
import { useSectionForm } from '../b11/draft-sync';
import type { UiResult } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { useAutosave } from './autosave-queue';
import { HiddenDraftInputs } from './form-helpers';
import { FARE_LABEL, fareTotal, fareTypes, flyersOf, type FareKey } from './service-model';

/*
 * "Total fare per person, all flights" under the flights list (Book now v2,
 * change 18). Per traveller type: when every flight carrying that type has a
 * fare, the total adds itself up and cannot be typed over; when no flight
 * has one (one ticket with a layover), staff type the total here; when only
 * some have one, the box names the flights still missing a fare. The live
 * sum counts the travellers of that type on at least one flight. Typed totals
 * save themselves through the page queue. Our cost, not the customer price.
 */

const POST: Record<FareKey, string> = { adult: 'fareAdultTotalRupees', child: 'fareChildTotalRupees', infant: 'fareInfantTotalRupees' };
const TOTAL_KEY: Record<FareKey, keyof FlightFareTotals> = { adult: 'adultPaise', child: 'childPaise', infant: 'infantPaise' };

export function FareBox({
  view,
  flights,
  travellers,
  totals,
  party,
  action,
  editable,
}: {
  view: BookNowView;
  flights: BookingFormServiceItemView[];
  travellers: BookTravellerView[];
  totals: FlightFareTotals | null;
  party: { children: number; infants: number };
  /** booking_flight_fares_save; absent = the typed totals are shown read-only. */
  action: B11Action | undefined;
  editable: boolean;
}) {
  const initial = { adult: paiseToRupeesText(totals?.adultPaise ?? null), child: paiseToRupeesText(totals?.childPaise ?? null), infant: paiseToRupeesText(totals?.infantPaise ?? null) } as Record<FareKey, string>;
  const f = useSectionForm({
    id: 'fares',
    section: 'services',
    label: 'Total fare per person',
    order: 45,
    action: action ?? (async () => ({ ok: false, code: 'unexpected', message: '' }) as never),
    initial,
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: true,
  });
  const v = f.values;
  const types = fareTypes(party);
  const shownTotals: FlightFareTotals = {
    adultPaise: rupeesToPaise(v.adult) || null,
    childPaise: rupeesToPaise(v.child) || null,
    infantPaise: rupeesToPaise(v.infant) || null,
  };
  const rows = types.map((k) => ({ k, t: fareTotal(flights, k, travellers, shownTotals) }));
  const allAuto = rows.every((r) => r.t.auto);
  const missing = rows.filter((r) => r.t.missing.length > 0);
  const sums = rows
    .map(({ k, t }) => {
      const n = flyersOf(flights, k, travellers);
      return t.paise === null || n === 0 ? null : { k, n, per: t.paise, sum: (BigInt(t.paise) * BigInt(n)).toString() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const bindForm = f.bindForm;
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      bindForm(el);
    },
    [bindForm],
  );
  const save = useAutosave({
    key: 'fares',
    values: v,
    dirty: f.dirty,
    enabled: editable && Boolean(action),
    hasStored: Boolean(totals?.adultPaise || totals?.childPaise || totals?.infantPaise),
    check: () => (types.some((k) => v[k].trim() !== '' && rupeesToPaise(v[k]) === undefined) ? ['Enter the total fare in rupees, with at most two decimal places.'] : []),
    send: () => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve({ ok: false, code: 'unexpected', message: '' } as UiResult)),
  });
  return (
    <form id="bf-fare-box" ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="bf-fare-title" className="mx-5 mb-1 flex flex-wrap items-end gap-x-3.5 gap-y-2 rounded-control bg-wash px-3.5 py-3 max-sm:mx-4">
      <HiddenDraftInputs view={view} base={f.base} result={f.state} />
      <span id="bf-fare-title" className="basis-full font-semibold text-ink">
        Total fare per person, all flights
      </span>
      {rows.map(({ k, t }) => (
        <div key={k} className="flex max-w-55 flex-[1_1_9.375rem] flex-col gap-1.5">
          <label htmlFor={`bf-fare-${k}`} className="font-medium text-ink">
            {FARE_LABEL[k]}
          </label>
          {t.auto ? (
            <div id={`bf-fare-${k}`} aria-readonly="true" role="textbox" aria-label={`${FARE_LABEL[k]}, added up`} className="flex min-h-10 items-center rounded-control border border-control bg-card px-3 tabular-nums">
              {formatInr(t.paise)}
              <input type="hidden" name={POST[k]} value={paiseToRupeesText(totals?.[TOTAL_KEY[k]] ?? null)} />
            </div>
          ) : (
            <MoneyInput id={`bf-fare-${k}`} name={POST[k]} value={v[k]} onChange={(e) => f.setValues((s) => ({ ...s, [k]: e.target.value }))} disabled={!editable || !action} />
          )}
        </div>
      ))}
      {types.length < 3
        ? (['child', 'infant'] as const).filter((k) => !types.includes(k)).map((k) => <input key={k} type="hidden" name={POST[k]} value={v[k]} />)
        : null}
      <p className="m-0 pb-2.5 text-sm text-copy tabular-nums" aria-live="polite">
        {sums.map((s) => (
          <span key={s.k} className="block">
            {FARE_LABEL[s.k]}: {formatInr(s.per)} × {s.n} = {formatInr(s.sum)}
          </span>
        ))}
        {sums.length > 0 ? (
          <span className="block">
            All flights: <strong className="text-ink">{formatInr(sums.reduce((a, s) => a + BigInt(s.sum), 0n).toString())}</strong>
          </span>
        ) : null}
      </p>
      <p className="m-0 basis-full text-sm text-quiet">
        {allAuto ? 'Added up from the fare on each flight. Change a flight’s fare to change it.' : 'Fills itself once every flight has a fare. One ticket with a layover? Type its total here instead.'} Our cost estimate, not the customer price.
      </p>
      {missing.length > 0 ? <p className="m-0 basis-full text-sm text-status-warning">{missing.map(({ k, t }) => `${FARE_LABEL[k]}: flight ${t.missing.join(', ')} has no fare yet`).join(' · ')}.</p> : null}
      {save.state === 'fix' && save.reason ? (
        <p role="alert" className="m-0 basis-full text-sm font-medium text-status-danger">
          Not saved: {save.reason}
        </p>
      ) : null}
    </form>
  );
}
