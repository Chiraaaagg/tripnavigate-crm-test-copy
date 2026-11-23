import type { RpcError } from '@/modules/fulfilment/commands';
import { formatEmailDate } from './email-draft';
import { isConflictSqlState } from '@/lib/sqlstate';

/**
 * Purchase "Booking changed" signal (Accounts phase contract 6.3.4, 7.6, 8.5,
 * 11.7; migration 20261203000430). The database compares the version the
 * task's assignee last worked from (basis) with the task's current version
 * and returns the item facts that changed (money keys never included), the
 * travellers of the item, trip dates and a budget flag (AL18: never an
 * amount). This file holds the frozen key -> label map, the DTO types, value
 * formatting and the error mapping. It is imported by the banner (a client
 * component), so it never imports zod (zod 4 probes `new Function`, which the
 * CSP blocks): the zod schemas and RPC wrappers live in
 * server/booking-change-rpc.ts.
 */

// ---------------------------------------------------------------------------
// Labels (frozen)
// ---------------------------------------------------------------------------

export const BOOKING_CHANGE_FIELD_LABEL: Record<string, string> = {
  hotelName: 'Hotel',
  city: 'City',
  area: 'Area',
  checkIn: 'Check-in',
  checkOut: 'Check-out',
  rooms: 'Rooms',
  roomType: 'Room type',
  mealPlan: 'Meal plan',
  adults: 'Adults',
  children: 'Children',
  childAges: 'Child ages',
  childrenWithoutBed: 'Children without bed',
  extraBeds: 'Extra beds',
  bedRemarks: 'Bed remarks',
  inclusions: 'Inclusions',
  exclusions: 'Exclusions',
  specialRequests: 'Special requests',
  requestItems: 'Requests',
  preferences: 'Preferences',
  notes: 'Notes',
  route: 'Route',
  date: 'Date',
  pickup: 'Pickup',
  drop: 'Drop',
  pickupTime: 'Pickup time',
  vehicleType: 'Vehicle',
  carKind: 'Car type',
  includedKms: 'Included kilometres',
  passengers: 'Passengers',
  name: 'Activity',
  time: 'Time',
  quantity: 'Quantity',
  vendor: 'Vendor',
  tripType: 'Trip type',
  mode: 'Mode',
  flex: 'Flexible dates',
};

export const BOOKING_CHANGE_TEXT = {
  title: (from: number, to: number) => `Booking changed: version ${from} → ${to}`,
  ack: 'OK, seen',
  acked: 'Marked as seen. You are now working from the latest booking.',
  readOnly: 'View only',
  budgetChanged: 'Budget changed',
  travellerAdded: 'Traveller added',
  travellerRemoved: 'Traveller removed',
  travellerRenamed: 'Name changed',
  travellerType: 'Traveller type changed',
  destination: 'Destination',
  start: 'Trip start',
  end: 'Trip end',
  emptyValue: 'Not set',
  homeRow: 'Bookings changed on your tasks',
} as const;

/** Keys the screen never shows even if a database ever returned them (defence in depth). */
const MONEY_KEY = /(paise|price|cost|estimate|budget|amount|discount|selling|margin|total|fare)/i;
/** Internal ids the banner never shows (the hotel name carries the change). */
const HIDDEN_KEYS = new Set(['participants', 'catalogueHotelId']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date "2026-11-25" as "25 Nov 2026"; anything else unchanged. */
export function formatChangeDate(value: string | null): string | null {
  return value !== null && ISO_DATE.test(value) ? formatEmailDate(value) : value;
}

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function bookingChangeLabel(key: string): string {
  return BOOKING_CHANGE_FIELD_LABEL[key] ?? humanize(key);
}

/** A facts value as one display line (arrays joined; objects as "key: value"); null when empty. */
export function formatFactValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : formatChangeDate(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map(formatFactValue).filter((v): v is string => v !== null);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !MONEY_KEY.test(k) && !HIDDEN_KEYS.has(k))
      .map(([k, v]) => {
        const f = formatFactValue(v);
        return f === null ? null : `${bookingChangeLabel(k)}: ${f}`;
      })
      .filter((v): v is string => v !== null);
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DTOs (section 8.5)
// ---------------------------------------------------------------------------

export interface BookingChangeFieldDTO {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface PurchaseBookingChangeDTO {
  taskId: string;
  basisVersionId: string;
  basisVersionNo: number;
  currentVersionId: string;
  currentVersionNo: number;
  changedAt: string | null;
  /** The assignee may press "OK, seen"; the Manager reads only. */
  canAck: boolean;
  /** AL18: a flag only, never amounts. */
  budgetChanged: boolean;
  fields: BookingChangeFieldDTO[];
  travellers: {
    added: Array<{ seq: number; name: string; type: 'adult' | 'child' | 'infant' }>;
    removed: Array<{ seq: number; name: string; type: 'adult' | 'child' | 'infant' }>;
    renamed: Array<{ seq: number; before: string; after: string }>;
    typeChanged: Array<{ seq: number; before: 'adult' | 'child' | 'infant'; after: 'adult' | 'child' | 'infant' }>;
  };
  tripChanged: {
    destination?: { before: string | null; after: string | null };
    start?: { before: string | null; after: string | null };
    end?: { before: string | null; after: string | null };
  } | null;
}

/** The read as the database returns it (validated by server/booking-change-rpc.ts). */
export interface PurchaseBookingChangeRaw extends Omit<PurchaseBookingChangeDTO, 'fields'> {
  fields: Array<{ key: string; before?: unknown; after?: unknown }>;
}

export interface BookingChangeAckResult {
  outcome: 'updated' | 'existing';
  taskId: string;
  basisVersionId: string;
  rowVersion: number;
}

export interface PurchaseHomeCountsDTO {
  purchaseBookingChanged: number;
  purchaseBookingChangedTaskId: string | null;
}

const datePairText = (p: { before: string | null; after: string | null } | undefined) =>
  p ? { before: formatChangeDate(p.before), after: formatChangeDate(p.after) } : undefined;

export function toBookingChangeDTO(raw: PurchaseBookingChangeRaw): PurchaseBookingChangeDTO {
  const trip = raw.tripChanged;
  return {
    ...raw,
    tripChanged: trip
      ? {
          ...(trip.destination ? { destination: trip.destination } : {}),
          ...(trip.start ? { start: datePairText(trip.start) } : {}),
          ...(trip.end ? { end: datePairText(trip.end) } : {}),
        }
      : null,
    fields: raw.fields
      .filter((f) => !MONEY_KEY.test(f.key) && !HIDDEN_KEYS.has(f.key))
      .map((f) => ({ key: f.key, label: bookingChangeLabel(f.key), before: formatFactValue(f.before), after: formatFactValue(f.after) })),
  };
}

// ---------------------------------------------------------------------------
// Errors and wrappers
// ---------------------------------------------------------------------------

export type BookingChangeErrorCode = 'not_authorized' | 'invalid_input' | 'version_changed' | 'duplicate_request';

export const BOOKING_CHANGE_ERROR_TEXT: Record<BookingChangeErrorCode | 'session', string> = {
  not_authorized: 'You cannot do this here.',
  invalid_input: 'Check the highlighted field.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload and try again.',
  session: 'Your session has ended. Sign in again.',
};

export class BookingChangeError extends Error {
  override name = 'BookingChangeError';
  constructor(
    readonly command: string,
    readonly code: BookingChangeErrorCode | 'session' | null,
    readonly sqlState: string | null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);

export function mapBookingChangeError(error: RpcError): BookingChangeErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (token === 'version_changed' && isConflictSqlState(state)) return 'version_changed';
  if (token === 'request_conflict' && isConflictSqlState(state)) return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === '22023') return 'invalid_input';
  return null;
}

export function isBookingChangeFunctionMissing(error: unknown): boolean {
  return error instanceof BookingChangeError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}
