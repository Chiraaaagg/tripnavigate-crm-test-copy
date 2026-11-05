'use client';

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/components/ui/cn';
import { shortDate } from './format';
import { CABINS } from './labels';
import { autoArrivalDate, parseFlightDate, parseFlightTime, TIME_MAX_LENGTH, TIME_OPTIONS } from './parse';

/*
 * The cells of one sector being typed (Alternate, Add sector, passenger
 * itinerary, screenshot sectors, fill missing details): the same cells as the
 * itinerary grid. Dates accept "2 Dec 26", "2/12/26" or "2026-12-02"; times
 * accept "1035", "10:35" or "7:05 pm" (8 characters; fixes the prototype's
 * maxlength 7) with a suggestion every 5 minutes. Fields wrap on narrow
 * screens; there is no sideways scroll.
 */

export interface SectorDraft {
  departDate: string;
  flightNo: string;
  from: string;
  to: string;
  departTime: string;
  arriveTime: string;
  arriveDate: string;
  airline: string;
  cabin: string;
}

export type SectorKey = keyof SectorDraft;
export type SectorErrors = Partial<Record<SectorKey, string>>;

export const EMPTY_SECTOR: SectorDraft = { departDate: '', flightNo: '', from: '', to: '', departTime: '', arriveTime: '', arriveDate: '', airline: '', cabin: 'Economy' };

const LABEL: Record<SectorKey, string> = {
  departDate: 'Date',
  flightNo: 'Flight no.',
  from: 'From',
  to: 'To',
  departTime: 'Dep time',
  arriveTime: 'Arr time',
  arriveDate: 'Arrival date',
  airline: 'Airline',
  cabin: 'Class',
};

const MISSING: Record<SectorKey, string> = {
  departDate: 'Enter the date of the flight.',
  flightNo: 'Enter the flight number.',
  from: 'Enter where the flight leaves from.',
  to: 'Enter where the flight lands.',
  departTime: 'Enter the departure time.',
  arriveTime: 'Enter the arrival time.',
  arriveDate: 'Enter the arrival date.',
  airline: 'Enter the airline.',
  cabin: 'Choose the class.',
};

const REQUIRED: SectorKey[] = ['departDate', 'flightNo', 'from', 'to', 'departTime', 'arriveTime', 'cabin'];

/** The stored shape (contract A4/A6) or the field errors. */
export function checkSector(d: SectorDraft, required: SectorKey[] = REQUIRED): { errors: SectorErrors; value: Record<string, string | null> | null } {
  const errors: SectorErrors = {};
  const date = d.departDate.trim() ? parseFlightDate(d.departDate) : null;
  const dep = d.departTime.trim() ? parseFlightTime(d.departTime) : null;
  const arr = d.arriveTime.trim() ? parseFlightTime(d.arriveTime) : null;
  const arrDate = d.arriveDate.trim() ? parseFlightDate(d.arriveDate) : autoArrivalDate(date, dep, arr);
  const place = (v: string) => (/^[a-z]{3}$/i.test(v.trim()) ? v.trim().toUpperCase() : v.trim());
  const from = place(d.from);
  const to = place(d.to);
  const flightNo = d.flightNo.trim().toUpperCase().replace(/\s+/g, ' ');
  for (const k of required) if (!d[k].trim()) errors[k] = MISSING[k];
  if (d.departDate.trim() && !date) errors.departDate = 'Type a real date, for example 2 Dec 26.';
  if (d.departTime.trim() && !dep) errors.departTime = 'Type a time, for example 10:35 or 7:05 pm.';
  if (d.arriveTime.trim() && !arr) errors.arriveTime = 'Type a time, for example 12:10.';
  if (d.arriveDate.trim() && !arrDate) errors.arriveDate = 'Type a real date.';
  if (date && arrDate && arrDate < date) errors.arriveDate = 'Arrival cannot be before departure.';
  const placeOk = (v: string) => /^[A-Z]{3}$/.test(v) || /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(v);
  if (from && !placeOk(from)) errors.from = 'Use the airport code (JDH) or the city name.';
  if (to && !placeOk(to)) errors.to = 'Use the airport code (BOM) or the city name.';
  if (from && to && from === to) errors.to = 'From and To must differ.';
  if (flightNo && !/^[A-Za-z0-9 -]{1,12}$/.test(flightNo)) errors.flightNo = 'Letters, digits, spaces or dashes; up to 12.';
  if (Object.keys(errors).length) return { errors, value: null };
  return {
    errors,
    value: {
      from,
      to,
      departDate: date,
      departTime: dep,
      arriveDate: arrDate,
      arriveTime: arr,
      flightNo: flightNo || null,
      airline: d.airline.trim() || null,
      cabin: d.cabin || null,
    },
  };
}

export function SectorFields({
  value,
  onChange,
  errors,
  idBase,
  only,
  firstFieldRef,
  legend,
}: {
  value: SectorDraft;
  onChange: (next: SectorDraft) => void;
  errors: SectorErrors;
  idBase: string;
  /** Only these cells can be typed (Fill missing details); the rest are shown read-only. */
  only?: SectorKey[];
  firstFieldRef?: (el: HTMLInputElement | null) => void;
  legend: string;
}) {
  const listId = useId();
  const set = (k: SectorKey, v: string) => onChange({ ...value, [k]: v });
  const can = (k: SectorKey) => !only || only.includes(k);
  const parsedDate = value.departDate ? parseFlightDate(value.departDate) : null;
  const firstKey = (['departDate', 'flightNo', 'departTime', 'arriveTime', 'arriveDate', 'airline'] as SectorKey[]).find(can);
  const cell = (k: SectorKey, input: React.ReactNode, hint?: string) => {
    const err = errors[k];
    const id = `${idBase}-${k}`;
    return (
      <div className="flex min-w-0 flex-col gap-1" key={k}>
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {LABEL[k]}
        </label>
        {input}
        {hint && !err ? (
          <span id={`${id}-hint`} className="text-xs text-quiet">
            {hint}
          </span>
        ) : null}
        {err ? (
          <span id={`${id}-error`} className="text-sm font-medium text-status-danger">
            {err}
          </span>
        ) : null}
      </div>
    );
  };
  const text = (k: SectorKey, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) =>
    cell(
      k,
      can(k) ? (
        <Input
          id={`${idBase}-${k}`}
          ref={k === firstKey ? firstFieldRef : undefined}
          value={value[k]}
          onChange={(e) => set(k, e.target.value)}
          invalid={!!errors[k]}
          aria-describedby={errors[k] ? `${idBase}-${k}-error` : hint ? `${idBase}-${k}-hint` : undefined}
          autoComplete="off"
          {...props}
        />
      ) : (
        <p id={`${idBase}-${k}`} className="m-0 min-h-10 py-2 text-base text-copy">
          {value[k] || '—'}
        </p>
      ),
      hint,
    );
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      <datalist id={listId}>
        {TIME_OPTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className={cn('grid min-w-0 gap-3', 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5')}>
        {text('departDate', { placeholder: '2 Dec 26', maxLength: 12 }, parsedDate ? shortDate(parsedDate) : 'e.g. 2 Dec 26')}
        {text('flightNo', { placeholder: 'AI 470', maxLength: 12, className: 'uppercase' })}
        {text('from', { placeholder: 'JDH', maxLength: 60 })}
        {text('to', { placeholder: 'BOM', maxLength: 60 })}
        {text('departTime', { placeholder: 'HH:MM', maxLength: TIME_MAX_LENGTH, list: listId, inputMode: 'text' })}
        {text('arriveTime', { placeholder: 'HH:MM', maxLength: TIME_MAX_LENGTH, list: listId, inputMode: 'text' })}
        {text('arriveDate', { placeholder: 'Same day', maxLength: 12 }, 'Empty = same day, or next day if earlier')}
        {text('airline', { placeholder: 'Air India', maxLength: 60 })}
        {cell(
          'cabin',
          can('cabin') ? (
            <Select id={`${idBase}-cabin`} value={value.cabin} onChange={(e) => set('cabin', e.target.value)} invalid={!!errors.cabin}>
              {CABINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          ) : (
            <p id={`${idBase}-cabin`} className="m-0 min-h-10 py-2 text-base text-copy">
              {value.cabin || '—'}
            </p>
          ),
        )}
      </div>
    </fieldset>
  );
}
