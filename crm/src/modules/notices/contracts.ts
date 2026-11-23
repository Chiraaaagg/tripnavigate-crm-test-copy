/**
 * Staff notices (Accounts phase contract sections 7.5, 8.4, 9; migrations
 * 20261203000400..0420; Accounts phase 2 contract 8.3-8.6 and 13.5,
 * migrations 20261204000420..0430). Frozen kinds, priorities, templates, link kinds,
 * the sound policy table, refusal tokens and their staff messages, and the
 * DTO types the bell reads. Templates are rendered here from `kind` and the
 * reference-only `params` (never names, amounts, PAN, phone, e-mail, PNR or
 * ticket numbers: the database stores none).
 */

export const NOTICE_KINDS = [
  'task_new',
  'task_assigned',
  'booking_changed',
  'review_returned',
  'review_approved',
  'supplier_confirmed',
  'task_completed',
  'trip_cancelled',
  'payment_reported',
  'receipt_to_verify',
  'payment_to_approve',
  'payment_to_record',
  'payment_to_verify',
  'payment_decided',
  'funding_to_approve',
  'bank_details_to_approve',
  'go_ahead_to_approve',
  'go_ahead_decided',
  'cost_over_budget',
  'fare_to_approve',
  'fare_decided',
  'expense_returned',
  'supplier_bill_returned',
  'visa_result',
  'tally_exception',
  // Accounts phase 2 (contract 8.3; 34 supplier_refund_to_verify dropped by Addendum L1).
  'refund_to_approve',
  'refund_decided',
  'refund_payout_due',
  'refund_paid',
  'document_to_release',
  'document_to_check',
  'credit_note_to_release',
  'supplier_refund_due',
  'cancellation_to_approve',
  'flight_charges_to_enter',
  'visa_cancel_decide',
  'refund_to_request',
  // Addendum L6
  'refund_shortfall',
  // Accounts phase 3, Release A (contract 8.6; migration 20261205000410): kinds 40-46.
  'bill_held',
  'write_off_to_approve',
  'write_off_decided',
  'message_failed',
  'whatsapp_stopped',
  'boarding_pass_due',
  'timer_stalled',
  // Accounts phase 3, Release B (contract 12; migration 20261205000800): kinds 50-60 (53 and 55 unused).
  'change_to_approve',
  'change_decided',
  'reconfirm_supplier',
  'change_not_possible',
  'reconfirm_undo',
  'removal_charges_to_enter',
  'contract_to_approve',
  'contract_decided',
  'contract_ending',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_PRIORITIES = ['urgent', 'normal'] as const;
export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];

export const NOTICE_RESOLVED_REASONS = ['acted', 'taken', 'handled_by_other', 'reassigned', 'revised', 'superseded'] as const;
export type NoticeResolvedReason = (typeof NOTICE_RESOLVED_REASONS)[number];

export const NOTICE_DEPARTMENTS = ['purchase', 'flight', 'visa'] as const;
export type NoticeDepartment = (typeof NOTICE_DEPARTMENTS)[number];

/** Where a notice opens (href.ts maps each to an existing route). */
export const NOTICE_LINK_KINDS = [
  'task',
  'deal',
  'accounts_deal',
  'claim',
  'supplier_payment',
  'funding',
  'approvals',
  'go_ahead',
  'flight_deal',
  'workspace_row',
  // Accounts phase 2 (8.6)
  'refund',
  'customer_document',
  'supplier_refund',
  'cancellation',
  // Accounts phase 3 (8.6): the Deal documents card, the Deal messages card, small balances, the timer state.
  'deal_documents',
  'deal_messages',
  'small_balances',
  'timer',
  // Accounts phase 3, Release B (12): the Deal's changes card (51, 54, and 3 for Accounts); a rate contract (59, 60).
  'deal_changes',
  'rate_contract',
] as const;
export type NoticeLinkKind = (typeof NOTICE_LINK_KINDS)[number];

/** The only params keys the database accepts (staff_notices.params allowlist). */
export const NOTICE_PARAM_KEYS = ['dealReference', 'department', 'refNo', 'serviceType', 'versionNo', 'status'] as const;
export type NoticeParamKey = (typeof NOTICE_PARAM_KEYS)[number];
export interface NoticeParams {
  dealReference?: string;
  department?: NoticeDepartment;
  /** SP-…, R-…, RF-…, WO-…, CR-…, RC-… or a customer document number (10101-INV-1). */
  refNo?: string;
  serviceType?: string;
  versionNo?: number;
  /**
   * approved / returned (decisions), on_hold (bank details), the outcome (visa), the record kind (Tally);
   * phase 2 routing markers 'entity' (refund_to_approve under LD32) and 'requester' (refund_paid);
   * phase 3: 'entity' also on write_off_to_approve and change_to_approve (LD37); the days left (30 | 7) of contract_ending.
   */
  status?: string;
}

export const NOTICE_ACTIONS = ['read', 'done', 'open'] as const;
export type NoticeMarkAction = (typeof NOTICE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// DTOs (section 8.4)
// ---------------------------------------------------------------------------

export interface NoticeLinkDTO {
  kind: NoticeLinkKind;
  id: string;
}

export interface NoticeItemDTO {
  noticeId: string;
  seq: number;
  kind: NoticeKind;
  priority: NoticePriority;
  /** receipt_to_verify still open after one working day: shown and counted as urgent (no sound). */
  escalated: boolean;
  createdAt: string;
  readAt: string | null;
  doneAt: string | null;
  resolvedAt: string | null;
  resolvedReason: NoticeResolvedReason | null;
  dealId: string | null;
  dealReference: string | null;
  taskId: string | null;
  department: NoticeDepartment | null;
  params: NoticeParams;
  link: NoticeLinkDTO | null;
}

export interface NoticeInboxDTO {
  /** False while the notices switch is off: the bell is hidden. */
  enabled: boolean;
  unreadCount: number;
  urgentCount: number;
  /** Highest seq of the caller's rows (the 30-second poll cursor); null when none. */
  latestSeq: number | null;
  soundOn: boolean;
  /**
   * Accounts phase 3 (8.5): the closed-browser alerts switch (Super Admin). Each person still opts in per
   * device. The database always sends it; optional in the type so older fixtures compile — read it with
   * `pushEnabledOf(inbox)` (missing = Off).
   */
  pushEnabled?: boolean;
  /**
   * Accounts phase 2 (8.5): urgent desktop pop-ups for this person (ON by default). The database always sends it;
   * optional in the type only so older preview fixtures still compile — read it with `popupsOnOf(inbox)`.
   */
  popupsOn?: boolean;
  items: NoticeItemDTO[];
}

/** Closed-browser alerts switch of an inbox (missing = Off, Accounts phase 3 contract 8.5). */
export function pushEnabledOf(inbox: Pick<NoticeInboxDTO, 'pushEnabled'> | null | undefined): boolean {
  return inbox?.pushEnabled ?? false;
}

/** Pop-ups preference of an inbox (missing = ON, contract 8.5). */
export function popupsOnOf(inbox: Pick<NoticeInboxDTO, 'popupsOn'> | null | undefined): boolean {
  return inbox?.popupsOn ?? true;
}

export interface NoticeHistoryDTO {
  enabled: boolean;
  items: NoticeItemDTO[];
  nextBefore: number | null;
}

export interface NoticeCountsDTO {
  unreadCount: number;
  urgentCount: number;
}

export interface NoticePreferencesDTO {
  soundOn: boolean;
  /** Accounts phase 2 (8.5); always sent by the database. */
  popupsOn: boolean;
}

/** N3 fields: at least one key (the other value is kept). */
export interface NoticePreferencesFields {
  soundOn?: boolean;
  popupsOn?: boolean;
}

export interface NoticeMarkResult {
  noticeId: string;
  readAt: string | null;
  doneAt: string | null;
}

export interface NoticeMarkAllResult {
  count: number;
}

// ---------------------------------------------------------------------------
// Refusals (section 7.7)
// ---------------------------------------------------------------------------

export type NoticeErrorCode = 'not_authorized' | 'not_found' | 'invalid_input';

export const NOTICE_ERROR_STATES: Record<NoticeErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  invalid_input: '22023',
};

export const NOTICE_ERROR_TEXT: Record<NoticeErrorCode | 'session', string> = {
  not_authorized: 'You cannot do this here.',
  not_found: 'This item is no longer available. Reload the page.',
  invalid_input: 'Check the highlighted field.',
  session: 'Your session has ended. Sign in again.',
};

/** Bell texts (section 9.4). */
export const NOTICE_TEXT = {
  outOfDate: 'Notices may be out of date — retrying',
  couldNotSave: 'Could not save — try again',
  empty: 'No notices',
  urgentLabel: 'Urgent',
  markAllRead: 'Mark all read',
  markRead: 'Mark read',
  done: 'Done',
  open: 'Open',
  history: 'History',
  soundOn: 'Sound on',
  soundOff: 'Sound off',
  testSound: 'Test sound',
  soundUnlock: 'Click anywhere to turn sound back on',
  soundLimits: 'Sound plays only while this browser is open on a computer and the browser allows it. It is not promised on phones.',
  // Accounts phase 2 (8.4, screen 13)
  popupsOn: 'Pop-ups on',
  popupsOff: 'Pop-ups off',
  popupsBlocked: 'Blocked by this browser — allow notifications for this site in the browser settings',
  popupsUnsupported: 'Not supported on this device',
  popupsLimits: 'Pop-ups appear only for urgent notices, only while this browser is open and the CRM tab is not in front.',
} as const;

// ---------------------------------------------------------------------------
// Templates (frozen, section 9.1)
// ---------------------------------------------------------------------------

const DEPARTMENT_WORD: Record<NoticeDepartment, string> = { purchase: 'Purchase', flight: 'Flight', visa: 'Visa' };
const DEPARTMENT_WORK: Record<NoticeDepartment, string> = { purchase: 'purchase', flight: 'flight', visa: 'visa' };

/** Tally record kinds carried in params.status of tally_exception notices. */
const TALLY_REFERENCE_KIND: Record<string, string> = {
  journal_entry: 'a receipt entry',
  supplier_payment: 'a supplier payment',
  supplier_document: 'a supplier bill',
  expense: 'an expense',
  tally_gst_invoice: 'a GST invoice reference',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : null;
}

/** The one-line text of a notice (references only). */
export function noticeText(item: Pick<NoticeItemDTO, 'kind' | 'params' | 'dealReference' | 'department'>): string {
  const p = item.params;
  const bx = item.dealReference ?? str(p.dealReference) ?? 'this booking';
  const dep = (item.department ?? (str(p.department) as NoticeDepartment | null)) as NoticeDepartment | null;
  const ref = str(p.refNo);
  const sp = ref ?? 'request';
  const status = str(p.status);
  const decided = status === 'approved' ? 'approved' : status === 'returned' ? 'returned' : 'decided';
  switch (item.kind) {
    case 'task_new':
      return dep ? `New ${DEPARTMENT_WORD[dep]} task on ${bx}` : `New task on ${bx}`;
    case 'task_assigned':
      return dep ? `${bx} ${DEPARTMENT_WORK[dep]} work is now yours` : `${bx} work is now yours`;
    case 'booking_changed':
      return `${bx} booking changed — check the details`;
    case 'review_returned':
      return `${bx} booking returned by Accounts`;
    case 'review_approved':
      return `${bx} booking approved by Accounts`;
    case 'supplier_confirmed':
      return `${bx} hotel confirmed by the supplier`;
    case 'task_completed':
      return dep ? `${bx} ${DEPARTMENT_WORK[dep]} work finished` : `${bx} work finished`;
    case 'trip_cancelled':
      return `${bx} trip cancelled — stop new work`;
    case 'payment_reported':
      return `Payment reported on ${bx}`;
    case 'receipt_to_verify':
      return ref ? `Receipt ${ref} on ${bx} needs verifying` : `Receipt on ${bx} needs verifying`;
    case 'payment_to_approve':
      return `Payment request ${sp} waiting for approval`;
    case 'payment_to_record':
      return `Payment request ${sp} approved — record the payment`;
    case 'payment_to_verify':
      return `Payment ${sp} recorded — verify it`;
    case 'payment_decided':
      return `Payment request ${sp} ${decided}`;
    case 'funding_to_approve':
      return `Company funding for ${sp} waiting for approval`;
    case 'bank_details_to_approve':
      return status === 'on_hold' ? 'Bank details waiting for approval — a payment is on hold' : 'Bank details waiting for approval';
    case 'go_ahead_to_approve':
      return `Go-ahead request on ${bx}`;
    case 'go_ahead_decided':
      return `Go-ahead on ${bx} ${decided}`;
    case 'cost_over_budget':
      return `Cost above budget on ${bx} waiting for you`;
    case 'fare_to_approve':
      return `Fares above budget on ${bx} waiting for you`;
    case 'fare_decided':
      return `Fare approval on ${bx} ${decided}`;
    case 'expense_returned':
      return `Expense returned on ${bx}`;
    case 'supplier_bill_returned':
      return `Supplier bill returned on ${bx}`;
    case 'visa_result':
      return `Visa result on ${bx}`;
    case 'tally_exception':
      return `Tally exception on ${(status && TALLY_REFERENCE_KIND[status]) ?? 'a record'} for ${bx}`;
    // Accounts phase 2 (8.3, frozen templates; references only)
    case 'refund_to_approve':
      return `Refund ${ref ?? 'request'} on ${bx} waiting for your approval`;
    case 'refund_decided':
      return `Refund ${ref ?? 'request'} on ${bx} ${decided}`;
    case 'refund_payout_due':
      return `Refund ${ref ?? 'request'} approved — pay it out`;
    case 'refund_paid':
      return `Refund ${ref ?? 'request'} on ${bx} paid`;
    case 'document_to_release':
      return `${bx}: a customer document is ready to release`;
    case 'document_to_check':
      return `${bx}: a released document needs checking`;
    case 'credit_note_to_release':
      return `${bx}: a credit note is ready to release`;
    case 'supplier_refund_due':
      return `${bx}: supplier refunds expected`;
    case 'cancellation_to_approve':
      return `Trip cancellation on ${bx} waiting for your approval`;
    case 'flight_charges_to_enter':
      return `${bx} trip cancelled — enter the airline charges`;
    case 'visa_cancel_decide':
      return `${bx} trip cancelled — decide on submitted visa applications`;
    case 'refund_to_request':
      return `${bx} cancellation approved — request the refund`;
    case 'refund_shortfall':
      return `${bx}: a reversed payment leaves the customer owing after a refund`;
    // Accounts phase 3, Release A (8.6, frozen templates; references only)
    case 'bill_held':
      return `${bx}: a bill is held — check it`;
    case 'write_off_to_approve':
      return `Write-off ${ref ?? 'request'} on ${bx} waiting for your approval`;
    case 'write_off_decided':
      return `Write-off ${ref ?? 'request'} on ${bx} ${status === 'approved' || status === 'returned' || status === 'undone' ? status : 'decided'}`;
    case 'message_failed':
      return `${bx}: a customer message could not be sent`;
    case 'whatsapp_stopped':
      return `${bx}: the customer stopped WhatsApp messages`;
    case 'boarding_pass_due':
      return `${bx}: boarding pass due — flight within 24 hours`;
    case 'timer_stalled':
      return 'Background jobs are late — check the timer';
    // Accounts phase 3, Release B (12, frozen templates; references only)
    case 'change_to_approve':
      return `Change ${ref ?? 'request'} on ${bx} waiting for your approval`;
    case 'change_decided':
      return `Change ${ref ?? 'request'} on ${bx} ${decided}`;
    case 'reconfirm_supplier':
      return `${bx}: booking changed — reconfirm with the supplier`;
    case 'change_not_possible':
      return `${bx}: the supplier could not make the change — the earlier booking stands`;
    case 'reconfirm_undo':
      return `${bx}: the change is off — tell the supplier to keep the earlier booking`;
    case 'removal_charges_to_enter':
      return `${bx}: a service is being removed — enter the supplier charges`;
    case 'contract_to_approve':
      return `${ref ? `Rate contract ${ref}` : 'A rate contract'} waiting for your approval`;
    case 'contract_decided':
      return `${ref ? `Rate contract ${ref}` : 'A rate contract'} ${decided}`;
    case 'contract_ending': {
      // params.status carries the days left (30 | 7).
      const days = status && /^[0-9]{1,3}$/.test(status) ? status : null;
      const rc = ref ? `Rate contract ${ref}` : 'A rate contract';
      return days ? `${rc} ends in ${days} days` : `${rc} ends soon`;
    }
  }
}

/** The grouped line of normal notices of one Deal (section 9.4). */
export function groupedText(count: number, dealReference: string): string {
  return `${count} updates on ${dealReference}`;
}

// ---------------------------------------------------------------------------
// Sound policy table (section 9.4)
// ---------------------------------------------------------------------------

export type NoticeTone = 'urgent' | 'normal' | 'none';

/** Urgent kinds play the urgent tone (bank details only when urgent); normal tone only for new / assigned tasks. */
export const NOTICE_TONE: Record<NoticeKind, NoticeTone> = {
  task_new: 'normal',
  task_assigned: 'normal',
  booking_changed: 'urgent',
  review_returned: 'urgent',
  review_approved: 'none',
  supplier_confirmed: 'none',
  task_completed: 'none',
  trip_cancelled: 'urgent',
  payment_reported: 'none',
  receipt_to_verify: 'none',
  payment_to_approve: 'none',
  payment_to_record: 'none',
  payment_to_verify: 'none',
  payment_decided: 'none',
  funding_to_approve: 'none',
  bank_details_to_approve: 'urgent',
  go_ahead_to_approve: 'none',
  go_ahead_decided: 'none',
  cost_over_budget: 'urgent',
  fare_to_approve: 'urgent',
  fare_decided: 'none',
  expense_returned: 'none',
  supplier_bill_returned: 'none',
  visa_result: 'none',
  tally_exception: 'none',
  // Accounts phase 2 (13.5)
  refund_to_approve: 'urgent',
  refund_decided: 'urgent',
  refund_payout_due: 'none',
  refund_paid: 'none',
  document_to_release: 'none',
  document_to_check: 'none',
  credit_note_to_release: 'none',
  supplier_refund_due: 'none',
  cancellation_to_approve: 'urgent',
  flight_charges_to_enter: 'urgent',
  visa_cancel_decide: 'urgent',
  refund_to_request: 'none',
  // Addendum L6: urgent tone and pop-up.
  refund_shortfall: 'urgent',
  // Accounts phase 3 (8.6): 45 and 46 urgent; 42 urgent only when returned (stored priority).
  bill_held: 'none',
  write_off_to_approve: 'none',
  write_off_decided: 'urgent',
  message_failed: 'none',
  whatsapp_stopped: 'none',
  boarding_pass_due: 'urgent',
  timer_stalled: 'urgent',
  // Accounts phase 3, Release B (12): 50, 52, 54, 56, 57 urgent; 51 and 59 urgent only when returned (stored priority).
  change_to_approve: 'urgent',
  change_decided: 'urgent',
  reconfirm_supplier: 'urgent',
  change_not_possible: 'urgent',
  reconfirm_undo: 'urgent',
  removal_charges_to_enter: 'urgent',
  contract_to_approve: 'none',
  contract_decided: 'urgent',
  contract_ending: 'none',
};

/** The tone a new notice plays (escalation never plays; bank details only when stored urgent). */
export function noticeTone(item: Pick<NoticeItemDTO, 'kind' | 'priority'>): NoticeTone {
  const tone = NOTICE_TONE[item.kind];
  // Stored-priority kinds: bank details (urgent when a payment is on hold); refund, write-off, change and rate
  // contract decisions (urgent when returned).
  if (
    item.kind === 'bank_details_to_approve' ||
    item.kind === 'refund_decided' ||
    item.kind === 'write_off_decided' ||
    item.kind === 'change_decided' ||
    item.kind === 'contract_decided'
  ) {
    return item.priority === 'urgent' ? 'urgent' : 'none';
  }
  return tone;
}

/**
 * Desktop pop-up table (Accounts phase 2, 13.5): only urgent kinds pop up — trip cancelled, refund to approve,
 * refund returned, cancellation to approve, airline charges, visa decisions, and the Phase 1 urgent kinds
 * (booking changed, review returned, cost / fares over budget, bank details on hold). An escalated receipt never pops up.
 */
export function noticePopsUp(item: Pick<NoticeItemDTO, 'kind' | 'priority'>): boolean {
  return item.priority === 'urgent' && noticeTone(item) === 'urgent';
}

/** Unread = neither resolved nor done (normal rows are done when read). */
export function isUnread(item: Pick<NoticeItemDTO, 'resolvedAt' | 'doneAt'>): boolean {
  return item.resolvedAt === null && item.doneAt === null;
}

/** Shown as urgent: stored urgent, or an escalated receipt. */
export function isShownUrgent(item: Pick<NoticeItemDTO, 'priority' | 'escalated'>): boolean {
  return item.priority === 'urgent' || item.escalated;
}

// ---------------------------------------------------------------------------
// Action results (server/actions.ts)
// ---------------------------------------------------------------------------

export type NoticeActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: NoticeErrorCode | 'session' | 'failed'; message: string };

/** A save the database did not confirm (section 9.4: the notice stays unread). */
export const NOTICE_FAILED_TEXT = NOTICE_TEXT.couldNotSave;

/** Notices switch (admin settings page; Super Admin, reason 10..500). */
export const NOTICE_SWITCH_TEXT = {
  on: 'Staff notices are switched on.',
  off: 'Staff notices are switched off.',
  reason: 'Write a reason of 10 to 500 characters.',
  notAllowed: 'Only a Super Admin can change this switch.',
} as const;

// ---------------------------------------------------------------------------
// Closed-browser alerts (Accounts phase 3, contract 8.1-8.5, 13; LD19, LD20)
// ---------------------------------------------------------------------------

/** The push payload title and the fixed body of a test alert (D4). */
export const PUSH_TITLE = 'TripNavigate';
export const PUSH_TEST_BODY = 'Test alert — alerts work on this device';
/** Kinds that get an alert besides urgent notices (8.2). */
export const PUSH_TASK_KINDS: readonly NoticeKind[] = ['task_new', 'task_assigned'];
export const MAX_PUSH_DEVICES_PER_PERSON = 10;

/** The only content sent to the browser's push service (encrypted by the Web Push standard). */
export type PushPayload = {
  title: string;
  /** The bell text of the notice (noticeText), or the fixed test text. References only. */
  body: string;
  /** tn-notice-<noticeId> (tn-test-<jobId> for a test alert): one notification per notice. */
  tag: string;
  /** A same-origin path (never a full URL). */
  url: string;
};

/** This browser's alert state (push-policy.ts). */
export const PUSH_STATES = ['unsupported', 'needs_home_screen', 'blocked', 'off', 'on'] as const;
export type PushState = (typeof PUSH_STATES)[number];

export interface PushDeviceDTO {
  deviceId: string;
  /** Words derived from the browser, e.g. "Chrome on Windows". */
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Matched by the sha256 of this browser's endpoint. */
  thisDevice: boolean;
}

/** D3 push_devices_list: the caller's own active devices; never an endpoint or key. */
export interface PushDevicesListDTO {
  enabled: boolean;
  devices: PushDeviceDTO[];
}

export type PushErrorCode = 'push_off' | 'push_too_many_devices' | 'not_ready' | NoticeErrorCode;

export const PUSH_ERROR_STATES: Record<PushErrorCode, string> = {
  push_off: '55000',
  push_too_many_devices: '55000',
  not_ready: '55000',
  ...NOTICE_ERROR_STATES,
};

/** Section 13 staff messages (not_ready = the D4 limit of 3 test alerts in 10 minutes). */
export const PUSH_ERROR_TEXT: Record<PushErrorCode | 'session' | 'failed' | 'unsupported' | 'blocked' | 'not_configured', string> = {
  push_off: 'Alerts on devices are not switched on yet.',
  push_too_many_devices: 'You already have 10 devices. Remove one first.',
  not_ready: 'You sent 3 test alerts in the last 10 minutes. Try again later.',
  not_authorized: NOTICE_ERROR_TEXT.not_authorized,
  not_found: 'This device is no longer on your list. Reload the list.',
  invalid_input: NOTICE_ERROR_TEXT.invalid_input,
  session: NOTICE_ERROR_TEXT.session,
  failed: NOTICE_TEXT.couldNotSave,
  unsupported: 'This browser does not support alerts.',
  blocked: 'Blocked by this browser. Allow notifications for this site in the browser settings, then try again.',
  not_configured: 'Alerts are not set up on this server yet.',
};

export const PUSH_OK_TEXT = {
  turnedOn: 'Alerts are on for this device.',
  turnedOff: 'Alerts are off for this device.',
  removed: 'Device removed.',
  testQueued: 'Test alert sent. It should arrive within a minute.',
} as const;

/** Alerts switch (admin settings page; Super Admin, reason 10..500; audited settings.notices_changed). */
export const PUSH_SWITCH_TEXT = {
  on: 'Alerts on devices are switched on. Each person still turns them on per device.',
  off: 'Alerts on devices are switched off.',
  reason: NOTICE_SWITCH_TEXT.reason,
  notAllowed: NOTICE_SWITCH_TEXT.notAllowed,
} as const;

/** Hidden field of the sign-out forms: this browser's alert endpoint, so sign-out removes this device (8.3 D2). */
export const PUSH_SIGNOUT_FIELD = 'pushEndpoint';
