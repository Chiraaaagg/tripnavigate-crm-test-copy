import {
  Check,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleOff,
  CircleX,
  Clock,
  FilePen,
  Hourglass,
  Info,
  Send,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from './badge';
import { cn } from './cn';

/*
 * C3: one status-to-colour table for the whole CRM (owner choice A: the
 * existing CRM badge with one shared table). A status is a closed kind, not
 * free words, so the same state has the same tone, icon and words on every
 * screen. Tone is never the only signal: every badge shows an icon and words.
 * The table follows the approved prototype (Tripnavigate-html-crm,
 * build/src/11-ui.js, statusTone). An unknown kind (bad data reaching the
 * screen) shows neutral with a clock, never a wrong colour.
 *
 * The local status maps move here slice by slice; a slice that needs a new
 * kind asks the lead to add it to this table.
 */

export interface StatusLook {
  tone: StatusTone;
  icon: LucideIcon;
  /** Default words when the page passes no label. */
  words: string;
}

const look = (tone: StatusTone, icon: LucideIcon, words: string): StatusLook => ({ tone, icon, words });

export const STATUS_TABLE = {
  // Booking and task progress
  not_started: look('neutral', Clock, 'Not started'),
  new: look('neutral', Clock, 'New'),
  draft: look('neutral', FilePen, 'Draft'),
  quotation_accepted: look('brand', Send, 'Quotation accepted'),
  booking_in_progress: look('info', CircleDot, 'Booking in progress'),
  in_progress: look('info', CircleDot, 'In progress'),
  being_arranged: look('info', CircleDot, 'Being arranged'),
  ready_to_submit: look('info', Info, 'Ready to submit'),
  ready_for_final_pdf: look('info', Info, 'Ready for final PDF'),
  booking_submitted: look('neutral', Hourglass, 'Booking submitted'),
  waiting_for_accounts: look('neutral', Hourglass, 'Waiting for Accounts'),
  waiting_to_be_taken: look('neutral', Hourglass, 'Waiting to be taken'),
  not_taken: look('neutral', Hourglass, 'Not taken'),
  sent_to_accounts: look('info', Send, 'Sent to Accounts'),
  sent: look('info', Send, 'Sent'),
  submitted: look('info', Send, 'Submitted'),
  returned_by_accounts: look('warning', Undo2, 'Returned by Accounts'),
  returned: look('warning', Undo2, 'Returned'),
  confirmed_by_supplier: look('success', CircleCheck, 'Confirmed by supplier'),
  all_services_confirmed: look('success', CircleCheck, 'All services confirmed'),
  confirmed: look('success', CircleCheck, 'Confirmed'),
  final_pdf_made: look('success', CircleCheck, 'Final PDF made'),
  done: look('success', CircleCheck, 'Done'),
  completed: look('success', CircleCheck, 'Completed'),
  cancelled: look('neutral', CircleX, 'Cancelled'),
  lost_in_bitrix: look('danger', CircleX, 'Lost in Bitrix'),
  lost: look('danger', CircleX, 'Lost'),
  // Money and approvals
  recorded: look('info', Info, 'Recorded'),
  verified: look('success', CircleCheck, 'Verified'),
  requested: look('info', Send, 'Requested'),
  approved: look('success', CircleCheck, 'Approved'),
  paid: look('success', CircleCheck, 'Paid'),
  released: look('success', CircleCheck, 'Released'),
  accepted: look('success', CircleCheck, 'Accepted'),
  declined: look('neutral', CircleX, 'Declined'),
  refused: look('danger', CircleX, 'Refused'),
  rejected: look('danger', CircleX, 'Rejected'),
  waiting_for_manager: look('warning', Hourglass, 'Waiting for the Manager'),
  waiting_for_accounts_approval: look('neutral', Hourglass, 'Waiting for Accounts approval'),
  go_ahead_waiting: look('warning', Hourglass, 'Go-ahead waiting'),
  go_ahead_given: look('success', CircleCheck, 'Go-ahead given'),
  on_hold: look('warning', TriangleAlert, 'On hold'),
  due: look('neutral', Clock, 'Due'),
  due_today: look('warning', TriangleAlert, 'Due today'),
  overdue: look('danger', CircleX, 'Overdue'),
  // Trip
  booked: look('success', CircleCheck, 'Booked'),
  travelled: look('info', Info, 'Travelled'),
  closed: look('neutral', CircleCheck, 'Closed'),
  // Settings and screen states
  on: look('success', CircleCheck, 'On'),
  off: look('neutral', CircleOff, 'Off'),
  switched_off: look('neutral', CircleOff, 'Switched off'),
  not_known: look('warning', CircleHelp, 'Not known'),
  needs_attention: look('warning', TriangleAlert, 'Needs attention'),
  // Notices
  unread: look('brand', CircleDot, 'Unread'),
  read: look('neutral', Check, 'Read'),
} as const satisfies Record<string, StatusLook>;

export type StatusKind = keyof typeof STATUS_TABLE;

export const STATUS_KINDS = Object.keys(STATUS_TABLE) as StatusKind[];

/** Shown for a kind that is not in the table: neutral, clock icon, "Not known". */
export const UNKNOWN_STATUS: StatusLook = look('neutral', Clock, 'Not known');

/** Tone, icon and default words of a status kind. An unknown kind gives UNKNOWN_STATUS. */
export function statusTone(kind: StatusKind | (string & {}) | null | undefined): StatusLook {
  return kind && Object.hasOwn(STATUS_TABLE, kind) ? STATUS_TABLE[kind as StatusKind] : UNKNOWN_STATUS;
}

export interface StatusProps {
  kind: StatusKind;
  /** The words on the badge; default the kind's words. Keep the page's existing words where tests read them. */
  label?: ReactNode;
  /** One plain fact beside the badge, e.g. "Raised 6 Nov 2026". */
  second?: ReactNode;
  /** Screen-reader words before the label, e.g. "State: ". */
  srPrefix?: string;
  /** Let long words wrap instead of being cut (see StatusBadge). */
  wrap?: boolean;
  className?: string;
}

/** One status badge (tone and icon from the shared table) with an optional second fact. */
export function Status({ kind, label, second, srPrefix, wrap, className }: StatusProps) {
  const t = statusTone(kind);
  const badge = (
    <StatusBadge tone={t.tone} icon={t.icon} wrap={wrap} data-kind={Object.hasOwn(STATUS_TABLE, kind) ? kind : 'unknown'}>
      {srPrefix ? <span className="sr-only">{srPrefix}</span> : null}
      {label ?? t.words}
    </StatusBadge>
  );
  if (second == null || second === '') return className ? <span className={cn('inline-flex max-w-full', className)}>{badge}</span> : badge;
  return (
    <span className={cn('inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 font-sans', className)} data-slot="status">
      {badge}
      <span className="text-sm text-quiet">{second}</span>
    </span>
  );
}
