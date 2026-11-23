import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';
import type { SupplierEmailKind } from './contracts';
import { SUPPLIER_EMAIL_BODY_MAX, SUPPLIER_EMAIL_SUBJECT_MAX } from './contracts';

/**
 * Pure drafts for supplier e-mails (owner decision 5, 2 November 2026).
 * Subjects carry the Deal ID: "Rate request · BX-… · <service> · <dates>".
 * A draft never carries a selling price, margin or Purchase budget: only the
 * service the customer booked and, for a booking request, the supplier's own
 * agreed rate. Staff may edit the draft before sending.
 */

export interface SupplierEmailDraftInput {
  kind: SupplierEmailKind;
  task: Pick<
    PurchaseTaskView,
    | 'dealReference'
    | 'itemTitle'
    | 'hotelName'
    | 'city'
    | 'checkIn'
    | 'checkOut'
    | 'nights'
    | 'rooms'
    | 'travellers'
    | 'roomType'
    | 'mealPlan'
    | 'specialRequests'
    | 'serviceType'
  >;
  /** Supplier contact name, else the supplier name. */
  greetingName: string;
  /** The Purchase person sending it. */
  senderName: string;
  /** Booking request only: the agreed final rate in paise (the supplier's own rate). */
  agreedRatePaise?: string | null;
  /** Booking request only: the offer's room type and meal plan when they differ from the booking. */
  offerRoomType?: string | null;
  offerMealPlan?: string | null;
}

export interface SupplierEmailDraft {
  subject: string;
  body: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-12-10" → "10 Dec 2026" (no time zone arithmetic: the date is a calendar date). */
export function formatEmailDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "10–13 Dec 2026", "28 Dec 2026 – 2 Jan 2027", or the single date. */
export function formatEmailDates(checkIn: string | null, checkOut: string | null): string | null {
  if (!checkIn && !checkOut) return null;
  if (!checkIn || !checkOut || checkIn === checkOut) return formatEmailDate((checkIn ?? checkOut)!);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(checkIn);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(checkOut);
  if (a && b && a[1] === b[1] && a[2] === b[2]) return `${Number(a[3])}–${formatEmailDate(checkOut)}`;
  return `${formatEmailDate(checkIn)} – ${formatEmailDate(checkOut)}`;
}

/** Integer paise → "₹40,000" or "₹40,000.50" (Indian grouping, string arithmetic only). */
export function formatEmailRupees(paise: string): string {
  if (!/^\d+$/.test(paise)) return paise;
  const padded = paise.padStart(3, '0');
  const rupees = padded.slice(0, -2).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-2);
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}${fraction === '00' ? '' : `.${fraction}`}`;
}

function serviceTitle(task: SupplierEmailDraftInput['task']): string {
  return task.itemTitle || [task.hotelName, task.city].filter(Boolean).join(', ') || 'Service';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildSupplierEmailSubject(kind: SupplierEmailKind, task: SupplierEmailDraftInput['task']): string {
  const label = kind === 'rate_request' ? 'Rate request' : 'Booking request';
  const dates = formatEmailDates(task.checkIn, task.checkOut);
  const parts = [label, task.dealReference, serviceTitle(task), ...(dates ? [dates] : [])];
  return clip(parts.join(' · '), SUPPLIER_EMAIL_SUBJECT_MAX);
}

export function buildSupplierEmailDraft(input: SupplierEmailDraftInput): SupplierEmailDraft {
  const { task } = input;
  const lines: string[] = [`Dear ${input.greetingName},`, ''];
  lines.push(
    input.kind === 'rate_request'
      ? 'Please share your best rate and availability for:'
      : 'Please confirm the following booking at the rate we agreed:',
    '',
    serviceTitle(task),
  );
  const dates = formatEmailDates(task.checkIn, task.checkOut);
  if (task.serviceType === 'hotel' && task.checkIn && task.checkOut) {
    lines.push(`Check-in: ${formatEmailDate(task.checkIn)} · Check-out: ${formatEmailDate(task.checkOut)} (${task.nights} night${task.nights === 1 ? '' : 's'})`);
  } else if (dates) {
    lines.push(`Date: ${dates}`);
  }
  const guests = [
    `${task.travellers.adults} adult${task.travellers.adults === 1 ? '' : 's'}`,
    ...(task.travellers.children > 0 ? [`${task.travellers.children} child${task.travellers.children === 1 ? '' : 'ren'}`] : []),
  ].join(', ');
  if (task.serviceType === 'hotel' && task.rooms > 0) {
    lines.push(`Rooms: ${task.rooms} · Guests: ${guests}`);
  } else {
    lines.push(`Guests: ${guests}`);
  }
  const roomType = input.kind === 'booking_request' ? (input.offerRoomType ?? task.roomType) : task.roomType;
  const mealPlan = input.kind === 'booking_request' ? (input.offerMealPlan ?? task.mealPlan) : task.mealPlan;
  if (roomType) lines.push(`Room type: ${roomType}`);
  if (mealPlan) lines.push(`Meal plan: ${mealPlan}`);
  if (task.specialRequests) lines.push(`Special requests: ${task.specialRequests}`);
  lines.push('');
  if (input.kind === 'rate_request') {
    lines.push('Please include the cancellation terms and how long you can hold the booking.');
  } else {
    if (input.agreedRatePaise) lines.push(`Agreed rate: ${formatEmailRupees(input.agreedRatePaise)} in total.`);
    lines.push('Please reply with your confirmation number and any deposit or proforma details.');
  }
  lines.push('', `Our reference: ${task.dealReference}`, '', 'Thank you,', input.senderName, 'Holiday Chacha');
  return { subject: buildSupplierEmailSubject(input.kind, task), body: clip(lines.join('\n'), SUPPLIER_EMAIL_BODY_MAX) };
}

/** "Open in e-mail app": a mailto link with To, Cc, subject and body (line breaks as CRLF). */
export function buildMailtoHref(input: { to: string; cc?: readonly string[]; subject: string; body: string }): string {
  const params: string[] = [];
  if (input.cc && input.cc.length > 0) params.push(`cc=${input.cc.map(encodeURIComponent).join(',')}`);
  params.push(`subject=${encodeURIComponent(input.subject)}`);
  params.push(`body=${encodeURIComponent(input.body.replace(/\r?\n/g, '\r\n'))}`);
  return `mailto:${encodeURIComponent(input.to).replace(/%40/g, '@')}?${params.join('&')}`;
}

/** "Copy draft": plain text with the headers a person needs to paste it. */
export function draftAsText(input: { to: string; cc?: readonly string[]; subject: string; body: string }): string {
  return [`To: ${input.to}`, ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []), `Subject: ${input.subject}`, '', input.body].join('\n');
}
