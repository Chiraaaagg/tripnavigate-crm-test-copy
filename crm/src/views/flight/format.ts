import { formatPaise } from '@/modules/deals/dto';
import type { BookedLeg, FlightSector, SectorSummary } from './types';

/*
 * Display helpers for the Flight screens. Pure and server-safe. Dates are
 * the booking's calendar dates ('YYYY-MM-DD', no time zone shift); times
 * stay as typed ('HH:MM').
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-14' → '14 Nov 26' (the prototype's short form). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]!.slice(2)}`;
}

/** Money from paise strings; never a float. */
export function inr(paise: string | null | undefined, empty = '—'): string {
  if (paise === null || paise === undefined || paise === '') return empty;
  try {
    return formatPaise(paise);
  } catch {
    return empty;
  }
}

/**
 * Flight number with the airline code once (contract 12.3: "AI 470", never
 * "AI AI 470"). An airline name that the number does not already start with
 * is shown before it ("IndiGo 6E 6142").
 */
export function flightLabel(airline: string | null | undefined, flightNo: string | null | undefined): string {
  const no = (flightNo ?? '').trim().replace(/\s+/g, ' ');
  const name = (airline ?? '').trim();
  if (!no) return name || '—';
  if (!name) return no;
  const compact = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
  if (compact(no).startsWith(compact(name))) return no;
  // A two-letter carrier code in front of a bare number: "AI" + "470".
  if (/^[A-Z0-9]{2}$/i.test(name) && /^\d/.test(no)) return `${name.toUpperCase()} ${no}`;
  return `${name} ${no}`;
}

export function routeText(from: string, to: string): string {
  return `${from || '—'} → ${to || '—'}`;
}

export function timeRange(dep: string | null | undefined, arr: string | null | undefined): string {
  return `${dep || '—'}–${arr || '—'}`;
}

/** One line per sector: "14 Nov 26 · AI 470 · JDH → BOM · 10:35–12:10". */
export function sectorLine(s: Pick<FlightSector, 'departDate' | 'departTime' | 'arriveTime' | 'flightNo' | 'airline' | 'from' | 'to'> | SectorSummary): string {
  return [shortDate(s.departDate), flightLabel(s.airline ?? null, s.flightNo), routeText(s.from, s.to), timeRange(s.departTime, s.arriveTime)].join(' · ');
}

export function legLine(l: Pick<BookedLeg, 'date' | 'airline' | 'flightNo' | 'from' | 'to' | 'departTime' | 'arriveTime'>): string {
  return [shortDate(l.date), flightLabel(l.airline, l.flightNo), routeText(l.from, l.to), timeRange(l.departTime, l.arriveTime)].join(' · ');
}

/** Sort sectors by date, then time (no time last), then id: the same order everywhere (contract 12.3). */
export function bySchedule<T extends { departDate: string; departTime: string | null; sectorId?: string }>(a: T, b: T): number {
  if (a.departDate !== b.departDate) return a.departDate < b.departDate ? -1 : 1;
  const at = a.departTime ?? '99:99';
  const bt = b.departTime ?? '99:99';
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.sectorId ?? '') < (b.sectorId ?? '') ? -1 : (a.sectorId ?? '') > (b.sectorId ?? '') ? 1 : 0;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
