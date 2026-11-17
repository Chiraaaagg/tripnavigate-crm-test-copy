'use client';

import { BadgeCheck, CalendarOff, CircleHelp, TriangleAlert } from 'lucide-react';
import { unstable_rethrow } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { compareToContract, dateText, differenceText, groupNights, inr, rangeText, rupeesToPaise } from './format';
import { LOOKUP_WORD, MEAL_PLAN_LABEL } from './labels';
import { MEAL_PLAN_CODES, type RateContractLookup } from './types';

/*
 * Purchase offer form › contract rate (Accounts phase 3 contract §9.2, §9.3
 * E9, R-E3, §15 item 9). A block the existing offer form slots in for a
 * hotel task with a catalogue hotel: room type and meal plan pick-lists,
 * "Contract rate ₹X for these dates" with the night-by-night detail, and —
 * when the typed total differs — the reason field E9 requires. The stay
 * dates and rooms come from the booking (never typed again). The database
 * prices the stay and stores the contract state; this block only shows it.
 * Field names: roomTypeId, mealPlanCode, contractDeviationReason (E9 allowlist).
 * With rate contracts switched off it renders nothing (behaviour as today).
 */

export type RateLookupAction = (input: { roomTypeId: string; mealPlanCode: string }) => Promise<{ ok: true; data: RateContractLookup | null } | { ok: false; message: string }>;

export function ContractRateBlock({
  enabled,
  hotelName,
  supplierChosen,
  stay,
  roomTypes,
  initial,
  lookup,
  quotedRupees,
  reasonError,
  defaultReason = '',
}: {
  enabled: boolean;
  /** The task's catalogue hotel; null = a hotel typed by hand (no contract rate possible). */
  hotelName: string | null;
  /** False until the offer form has a supplier picked. */
  supplierChosen: boolean;
  stay: { checkIn: string; checkOut: string; rooms: number };
  roomTypes: Array<{ roomTypeId: string; name: string }>;
  initial?: { roomTypeId?: string; mealPlanCode?: string; result?: RateContractLookup | null };
  /** R-E3 rate_contract_lookup for the task and the picked supplier (route-bound server action). */
  lookup: RateLookupAction;
  /** The offer's typed total (rupees), to say "matches" or "differs". */
  quotedRupees: string;
  /** E9 refusal `invalid_input` hint `contractDeviationReason`. */
  reasonError?: string | null;
  defaultReason?: string;
}) {
  const base = useId();
  const [roomTypeId, setRoomTypeId] = useState(initial?.roomTypeId ?? '');
  const [mealPlanCode, setMealPlanCode] = useState(initial?.mealPlanCode ?? '');
  const [result, setResult] = useState<RateContractLookup | null>(initial?.result ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!enabled) return null;

  const types = result?.roomTypes ?? roomTypes;
  const run = (rt: string, mp: string) => {
    if (!rt || !mp || !supplierChosen || !hotelName) {
      setResult(null);
      return;
    }
    start(async () => {
      try {
        const r = await lookup({ roomTypeId: rt, mealPlanCode: mp });
        if (r.ok) {
          setResult(r.data);
          setFailure(null);
        } else {
          setFailure(r.message);
        }
      } catch (error) {
        unstable_rethrow(error);
        setFailure('The contract rate could not be looked up. You can still enter the supplier’s rate.');
      }
    });
  };
  const quotedPaise = rupeesToPaise(quotedRupees) ?? null;
  const compare = compareToContract(quotedPaise, result);
  const nightCount = result?.nights.length ?? 0;
  const reasonId = `${base}-reason`;

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-control border border-line bg-wash p-3.5 font-sans text-base text-copy">
      <legend className="px-1 text-base font-semibold text-ink">Contract rate</legend>
      {!hotelName ? (
        <p className="m-0 text-sm text-quiet">The hotel was typed by hand, so no contract rate can be looked up. Enter the supplier’s rate.</p>
      ) : (
        <>
          <p className="m-0 text-sm text-quiet">
            {hotelName} · {rangeText(stay.checkIn, stay.checkOut)} · {stay.rooms} {stay.rooms === 1 ? 'room' : 'rooms'} (from the booking)
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field htmlFor={`${base}-roomType`} label="Room type" hint={types.length === 0 ? 'No room types for this hotel yet. Purchase adds them on a rate contract.' : undefined}>
              <Select
                id={`${base}-roomType`}
                name="roomTypeId"
                value={roomTypeId}
                onChange={(e) => {
                  setRoomTypeId(e.target.value);
                  run(e.target.value, mealPlanCode);
                }}
                aria-describedby={types.length === 0 ? `${base}-roomType-hint` : undefined}
              >
                <option value="">Choose…</option>
                {types.map((r) => (
                  <option key={r.roomTypeId} value={r.roomTypeId}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field htmlFor={`${base}-meal`} label="Meal plan">
              <Select
                id={`${base}-meal`}
                name="mealPlanCode"
                value={mealPlanCode}
                onChange={(e) => {
                  setMealPlanCode(e.target.value);
                  run(roomTypeId, e.target.value);
                }}
              >
                <option value="">Choose…</option>
                {MEAL_PLAN_CODES.map((c) => (
                  <option key={c} value={c}>
                    {MEAL_PLAN_LABEL[c]} ({c})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div role="status" aria-live="polite" className="flex flex-col gap-2">
            {!supplierChosen ? (
              <p className="m-0 text-sm text-quiet">Choose the supplier first to see its contract rate.</p>
            ) : pending ? (
              <p className="m-0 text-sm text-quiet">Looking up the contract rate…</p>
            ) : failure ? (
              <Notice tone="warning" title="Contract rate not shown">
                <p>{failure}</p>
              </Notice>
            ) : !result ? (
              <p className="m-0 text-sm text-quiet">Pick the room type and meal plan to see the contract rate for these dates.</p>
            ) : result.state === 'ok' && result.totalPaise ? (
              <div className="flex flex-col gap-2 rounded-control border border-line bg-card px-3 py-2.5">
                <p className="m-0 text-sm text-quiet">{LOOKUP_WORD.ok}</p>
                <p className="m-0 text-xl font-semibold text-ink tabular-nums">Contract rate {inr(result.totalPaise)}</p>
                <p className="m-0 text-sm text-quiet">
                  {inr(result.perRoomTotalPaise)} per room for {nightCount} {nightCount === 1 ? 'night' : 'nights'} × {stay.rooms} {stay.rooms === 1 ? 'room' : 'rooms'}
                </p>
                <NightDetail result={result} />
              </div>
            ) : result.state === 'ended' ? (
              <Notice tone="warning" icon={CalendarOff} title={`Contract ended on ${dateText(result.endedOn)}`}>
                <p>No contract covers these dates now. Enter the supplier’s current rate.</p>
              </Notice>
            ) : result.state === 'partial' ? (
              <Notice tone="warning" title={LOOKUP_WORD.partial}>
                <p>Only {nightCount} of the nights have a contract rate. Enter the supplier’s rate for the whole stay.</p>
                <NightDetail result={result} />
              </Notice>
            ) : result.state === 'blackout' ? (
              <Notice tone="warning" icon={CalendarOff} title={LOOKUP_WORD.blackout}>
                <p>The contract rate does not apply on blackout nights. Enter the supplier’s rate for the whole stay.</p>
              </Notice>
            ) : (
              <p className="m-0 flex items-center gap-2 text-sm text-copy">
                <CircleHelp aria-hidden="true" className="size-4 shrink-0 text-quiet" />
                {LOOKUP_WORD.no_contract}. Enter the supplier’s rate.
              </p>
            )}
            {result?.state === 'ok' && result.totalPaise && supplierChosen && !pending ? (
              compare === 'matches' ? (
                <StatusBadge tone="success" icon={BadgeCheck} wrap>
                  Matches the contract
                </StatusBadge>
              ) : compare === 'differs' && quotedPaise ? (
                <StatusBadge tone="warning" icon={TriangleAlert} wrap>
                  Differs from contract: {differenceText(quotedPaise, result.totalPaise)}
                </StatusBadge>
              ) : compare === 'not_priced' ? (
                <p className="m-0 text-sm text-quiet">Enter the offer total to compare it with the contract.</p>
              ) : null
            ) : null}
          </div>
          {compare === 'differs' ? (
            <Field htmlFor={reasonId} label="Why is this different from the contract?" hint="10 to 300 characters. The Manager sees it before approving a cost above budget." error={reasonError}>
              <Textarea id={reasonId} name="contractDeviationReason" minLength={10} maxLength={300} rows={2} required defaultValue={defaultReason} invalid={!!reasonError} aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonError })} />
            </Field>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function NightDetail({ result }: { result: RateContractLookup }) {
  const runs = groupNights(result.nights);
  if (runs.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="w-fit cursor-pointer rounded-chip font-medium text-brand-strong">Night by night</summary>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
        {runs.map((r) => (
          <li key={`${r.from}-${r.lineId}`} className="flex flex-wrap justify-between gap-x-3 border-b border-line py-1 last:border-b-0">
            <span>
              {rangeText(r.from, r.to)} · {r.nights} {r.nights === 1 ? 'night' : 'nights'}
              {r.weekend ? ' (weekend rate)' : ''}
            </span>
            <span className="tabular-nums">{inr(r.ratePaise)} a night</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Preview and design-review frame: the block with the offer total input it
 * reads in the real offer form. The real form passes its own typed total.
 */
export function ContractRateBlockFrame(props: Omit<Parameters<typeof ContractRateBlock>[0], 'quotedRupees'> & { quotedRupees?: string }) {
  const id = useId();
  const [quoted, setQuoted] = useState(props.quotedRupees ?? '');
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Field htmlFor={`${id}-quoted`} label="Offer total for the stay (₹)" hint="In the offer form this is the existing “Quoted cost” field.">
        <MoneyInput id={`${id}-quoted`} name="quotedCostRupees" value={quoted} onChange={(e) => setQuoted(e.target.value)} aria-describedby={`${id}-quoted-hint`} />
      </Field>
      <ContractRateBlock {...props} quotedRupees={quoted} />
    </div>
  );
}

/** Track E's lookup server action (unbound): the offer form binds the task, the picked supplier and the hotel per call. */
export type RawRateLookupAction = (
  bound: { taskId: string; supplierId: string; hotelId: string },
  input: { roomTypeId: string; mealPlanCode: string },
) => Promise<{ ok: true; data: RateContractLookup | null } | { ok: false; message: string }>;

/**
 * The contract block inside the real Purchase offer form (contract 9.2, 9.3
 * E9): reads the hotel's room types for the picked supplier (an empty
 * lookup), then prices the stay when a room type and meal plan are picked.
 * Its fields (roomTypeId, mealPlanCode, contractDeviationReason) post with
 * the offer form.
 */
export function OfferContractBlock({
  enabled,
  rawLookup,
  taskId,
  supplierId,
  hotelId,
  hotelName,
  stay,
  quotedRupees,
  reasonError,
}: {
  enabled: boolean;
  rawLookup: RawRateLookupAction;
  taskId: string;
  supplierId: string;
  hotelId: string;
  hotelName: string | null;
  stay: { checkIn: string; checkOut: string; rooms: number };
  quotedRupees: string;
  reasonError?: string | null;
}) {
  const [roomTypes, setRoomTypes] = useState<Array<{ roomTypeId: string; name: string }>>([]);
  const ready = enabled && !!supplierId && !!hotelId;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    rawLookup({ taskId, supplierId, hotelId }, { roomTypeId: '', mealPlanCode: '' })
      .then((r) => {
        if (live) setRoomTypes(r.ok && r.data ? r.data.roomTypes : []);
      })
      .catch(() => {
        if (live) setRoomTypes([]);
      });
    return () => {
      live = false;
    };
  }, [ready, rawLookup, taskId, supplierId, hotelId]);
  return (
    <ContractRateBlock
      key={`${supplierId}:${hotelId}`}
      enabled={enabled}
      hotelName={hotelId ? hotelName : null}
      supplierChosen={!!supplierId}
      stay={stay}
      roomTypes={roomTypes}
      lookup={(input) => rawLookup({ taskId, supplierId, hotelId }, input)}
      quotedRupees={quotedRupees}
      reasonError={reasonError}
    />
  );
}
