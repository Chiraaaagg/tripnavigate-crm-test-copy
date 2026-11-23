import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import type { ContractFields, LineInput } from './commands';
import { LINE_HINT_FORM_FIELD, MEAL_PLAN_CODES, RATE_CONTRACT_MAX_BLACKOUTS, RATE_CONTRACT_MAX_LINES, RATE_FIELD as F } from './contracts';

/**
 * Pure form readers for the rate contract actions (no server imports). They
 * only tidy what staff typed; the database is the authority for every rule
 * (dates inside the validity, overlaps, room types of the hotel). A refusal
 * names the form field so the screen can mark it and keep what was typed.
 */

export type FormRead<T> = { ok: true; value: T } | { ok: false; field: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function str(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Whole non-negative row version (0 allowed for "new"). */
export function readRowVersion(formData: FormData, allowZero = false): number | null {
  const raw = str(formData, F.expectedRowVersion);
  if (raw === null) return allowZero ? 0 : null;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n === 0 && !allowZero ? null : n;
}

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, F.requestId);
}

/** Header fields of E3 (new: supplier and hotel required; existing: they are sent unchanged). */
export function readContractFields(formData: FormData): FormRead<ContractFields> {
  const fields: ContractFields = {};
  const supplierId = str(formData, F.supplierId);
  const hotelId = str(formData, F.hotelId);
  if (supplierId !== null) {
    const id = readUuid(formData, F.supplierId);
    if (!id) return { ok: false, field: F.supplierId };
    fields.supplierId = id;
  }
  if (hotelId !== null) {
    const id = readUuid(formData, F.hotelId);
    if (!id) return { ok: false, field: F.hotelId };
    fields.hotelId = id;
  }
  const validFrom = str(formData, F.validFrom);
  const validTo = str(formData, F.validTo);
  if (validFrom === null || !ISO.test(validFrom)) return { ok: false, field: F.validFrom };
  if (validTo === null || !ISO.test(validTo)) return { ok: false, field: F.validTo };
  fields.validFrom = validFrom;
  fields.validTo = validTo;
  const terms = str(formData, F.cancellationTerms);
  if (terms !== null && terms.length > 2000) return { ok: false, field: F.cancellationTerms };
  fields.cancellationTerms = terms;
  const note = str(formData, F.note);
  if (note !== null && note.length > 500) return { ok: false, field: F.note };
  fields.note = note;
  return { ok: true, value: fields };
}

function count(formData: FormData, name: string, max: number): number | null {
  const raw = str(formData, name) ?? '0';
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= max ? n : null;
}

/** E4: lines[i].<key> (rupee inputs) and blackouts[i].fromDate / toDate. */
export function readLinesForm(formData: FormData): FormRead<{ lines: LineInput[]; blackouts: Array<{ fromDate: string; toDate: string }> }> {
  const lineCount = count(formData, F.lineCount, RATE_CONTRACT_MAX_LINES);
  const blackoutCount = count(formData, F.blackoutCount, RATE_CONTRACT_MAX_BLACKOUTS);
  if (lineCount === null) return { ok: false, field: 'lines' };
  if (blackoutCount === null) return { ok: false, field: 'blackouts' };
  const lines: LineInput[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const k = (f: string) => `lines[${i}].${f}`;
    const seasonFrom = str(formData, k('seasonFrom'));
    const seasonTo = str(formData, k('seasonTo'));
    if (!seasonFrom || !ISO.test(seasonFrom)) return { ok: false, field: k('seasonFrom') };
    if (!seasonTo || !ISO.test(seasonTo)) return { ok: false, field: k('seasonTo') };
    const roomTypeId = readUuid(formData, k('roomTypeId'));
    if (!roomTypeId) return { ok: false, field: k('roomTypeId') };
    const mealPlan = str(formData, k('mealPlan'));
    if (!mealPlan || !(MEAL_PLAN_CODES as readonly string[]).includes(mealPlan)) return { ok: false, field: k('mealPlan') };
    const money: Record<string, string | null> = {};
    for (const [key, formKey] of Object.entries(LINE_HINT_FORM_FIELD)) {
      const p = rupeesToPaise(str(formData, k(formKey)) ?? undefined);
      if (p === undefined || (key === 'ratePaise' && (p === null || p === '0')) || (key === 'weekendRatePaise' && p === '0')) {
        return { ok: false, field: k(formKey) };
      }
      money[key] = p;
    }
    const note = str(formData, k('note'));
    if (note !== null && note.length > 300) return { ok: false, field: k('note') };
    lines.push({
      seasonFrom, seasonTo, roomTypeId, mealPlan, ratePaise: money.ratePaise!, weekendRatePaise: money.weekendRatePaise ?? null,
      extraAdultPaise: money.extraAdultPaise ?? null, childWithBedPaise: money.childWithBedPaise ?? null,
      childWithoutBedPaise: money.childWithoutBedPaise ?? null, note,
    });
  }
  const blackouts: Array<{ fromDate: string; toDate: string }> = [];
  for (let i = 0; i < blackoutCount; i += 1) {
    const fromDate = str(formData, `blackouts[${i}].fromDate`);
    const toDate = str(formData, `blackouts[${i}].toDate`);
    if (!fromDate || !ISO.test(fromDate)) return { ok: false, field: `blackouts[${i}].fromDate` };
    if (!toDate || !ISO.test(toDate)) return { ok: false, field: `blackouts[${i}].toDate` };
    blackouts.push({ fromDate, toDate });
  }
  return { ok: true, value: { lines, blackouts } };
}

/** A database hint (lines[2].ratePaise, validTo, reason) as the form field it refers to (lines[2].rateRupees). */
export function hintToFormField(hint: string | null): string | undefined {
  if (!hint) return undefined;
  const m = /^(lines|blackouts)\[(\d+)\]\.(\w+)$/.exec(hint);
  if (m) return `${m[1]}[${m[2]}].${LINE_HINT_FORM_FIELD[m[3]!] ?? m[3]}`;
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(hint) || /^(lines|blackouts)(\[\d+\])?$/.test(hint) ? hint : undefined;
}

/** The last segment of a form field, for its wording (lines[2].rateRupees -> rateRupees). */
export function fieldKey(field: string): string {
  const m = /\.(\w+)$/.exec(field);
  return m ? m[1]! : field.replace(/\[\d+\]$/, '');
}
