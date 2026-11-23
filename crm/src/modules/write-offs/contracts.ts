/**
 * Write-offs (Accounts phase 3, track B): frozen vocabularies, refusal
 * tokens and staff messages, form field names (Phase 2 Addendum L3) and
 * command result shapes.
 *
 * Contract: implementation/accounts-phase3-2026-11-12/contract.md sections
 * 6.6, 13, 14, 21 LD15, LD16 (frozen 12 Nov 2026). Database:
 * crm/supabase/migrations/20261205000200 (table), 0220 (commands, reads),
 * 0230 (dues effect). Money is whole paise as decimal strings; no floats.
 */

export type Paise = string;

export const WRITE_OFF_DIRECTIONS = ['due', 'excess'] as const;
export type WriteOffDirection = (typeof WRITE_OFF_DIRECTIONS)[number];

export const WRITE_OFF_STATUSES = ['proposed', 'approved', 'returned', 'withdrawn', 'undone'] as const;
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number];

/** B3 not_ready hints (contract order), as the database names them. */
export const WRITE_OFF_NOT_READY_HINTS = [
  'trip_not_ended',
  'refund_open',
  'cancellation_open',
  'change_open',
  'receipt_unverified',
  'shortfall',
] as const;
export type WriteOffNotReadyHint = (typeof WRITE_OFF_NOT_READY_HINTS)[number];

/** R-B1 blockedBy codes: the switch, the not_ready hints, and the limit. */
export const WRITE_OFF_BLOCK_CODES = ['write_off_off', ...WRITE_OFF_NOT_READY_HINTS, 'over_limit'] as const;
export type WriteOffBlockCode = (typeof WRITE_OFF_BLOCK_CODES)[number];

export const SMALL_BALANCE_PRESETS = ['to_propose', 'to_approve', 'needs_review'] as const;
export type SmallBalancePreset = (typeof SMALL_BALANCE_PRESETS)[number];

export const WRITE_OFF_DECISIONS = ['approve', 'return'] as const;
export type WriteOffDecision = (typeof WRITE_OFF_DECISIONS)[number];

/** Audit actions (contract 17.3). */
export const WRITE_OFF_AUDIT_ACTIONS = [
  'accounts.write_off.proposed',
  'accounts.write_off.approved',
  'accounts.write_off.returned',
  'accounts.write_off.withdrawn',
  'accounts.write_off.undone',
] as const;

// ---------------------------------------------------------------------------
// Refusal tokens (section 13) and frozen messages
// ---------------------------------------------------------------------------

export type WriteOffErrorCode =
  | 'write_off_off'
  | 'write_off_over_limit'
  | 'write_off_not_balance'
  | 'write_off_open_exists'
  | 'not_ready'
  | 'not_self_approval'
  | 'wrong_state'
  | 'version_changed'
  | 'request_conflict'
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'environment_unset'
  | 'not_configured';

/** Each token and the only SQLSTATE it may arrive with. */
export const WRITE_OFF_ERROR_STATES: Readonly<Record<WriteOffErrorCode, string>> = Object.freeze({
  write_off_off: '55000',
  write_off_over_limit: '22023',
  write_off_not_balance: '22023',
  write_off_open_exists: '23505',
  not_ready: '55000',
  not_self_approval: '42501',
  wrong_state: '55000',
  version_changed: '40001',
  request_conflict: '40001',
  invalid_input: '22023',
  not_authorized: '42501',
  not_found: 'P0002',
  environment_unset: '55000',
  not_configured: '55000',
});

export const WRITE_OFF_ERROR_TEXT: Readonly<Record<WriteOffErrorCode | 'session', string>> = Object.freeze({
  write_off_off: 'Write-offs are not switched on yet.',
  write_off_over_limit: 'This is more than the write-off limit for one Deal.',
  write_off_not_balance: 'A write-off must be the whole remaining balance.',
  write_off_open_exists: 'This Deal already has a write-off.',
  not_ready: 'A write-off is not possible on this Deal yet.',
  not_self_approval: 'You cannot approve your own request.',
  wrong_state: 'This write-off has moved on. Refresh the page to see where it is now.',
  version_changed: 'Someone changed this meanwhile. Refresh the page and try again.',
  request_conflict: 'This request was already used for something else. Refresh the page and try again.',
  invalid_input: 'Check the highlighted field.',
  not_authorized: 'You cannot do this.',
  not_found: 'This write-off could not be found.',
  environment_unset: 'The CRM is not set up for money work yet. Tell the CRM team.',
  not_configured: 'Money work is not switched on for this company yet. Tell the CRM team.',
  session: 'Your session ended. Sign in again.',
});

/** The reason line each not_ready hint adds; also the words of R-B1 blockedBy. */
export const WRITE_OFF_BLOCK_TEXT: Readonly<Record<WriteOffBlockCode, string>> = Object.freeze({
  write_off_off: 'Write-offs are not switched on yet.',
  trip_not_ended: 'The trip has not ended yet.',
  refund_open: 'A refund request is still open on this Deal.',
  cancellation_open: 'A trip cancellation is not approved yet.',
  change_open: 'A booking change is still in progress.',
  receipt_unverified: 'A payment is reported or not yet verified.',
  shortfall: 'Money held is below zero. Fix the money first.',
  over_limit: 'More than the write-off limit for one Deal.',
});

export const WRITE_OFF_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm whether this was saved. Refresh the page before trying again.';

export const WRITE_OFF_DONE_TEXT = Object.freeze({
  proposed: 'Write-off proposed. The branch Manager decides next.',
  approved: 'Write-off approved. The balance is now zero.',
  returned: 'Write-off returned to Accounts with your reason.',
  withdrawn: 'Write-off withdrawn.',
  undone: 'Write-off undone. The balance is back on the Deal.',
  switched: 'Saved.',
  existing: 'Already done. Nothing changed.',
});

// ---------------------------------------------------------------------------
// Form field names (Addendum L3: hidden binding values in paise)
// ---------------------------------------------------------------------------

export const WRITE_OFF_FIELD = Object.freeze({
  dealId: 'dealId',
  writeOffId: 'writeOffId',
  direction: 'direction',
  /** Hidden: the whole balance shown on the screen, in paise (a write-off is never typed). */
  amountPaise: 'amountPaise',
  /** Hidden: the amount the approver saw, in paise. */
  expectedAmountPaise: 'expectedAmountPaise',
  expectedRowVersion: 'expectedRowVersion',
  decision: 'decision',
  reason: 'reason',
  requestId: 'requestId',
  entityId: 'entityId',
  enabled: 'enabled',
  /** Settings form: the limit typed in rupees. */
  limitRupees: 'limitRupees',
} as const);

/** Pages revalidated after a write-off command. */
export const WRITE_OFF_PATHS = ['/app/accounts/small-balances', '/app/accounts', '/app/approvals'] as const;

// ---------------------------------------------------------------------------
// Command results and the action result
// ---------------------------------------------------------------------------

export interface WriteOffCommandResult {
  outcome: 'created' | 'updated' | 'existing';
  writeOffId: string;
  dealId: string;
  refNo: string;
  direction: WriteOffDirection;
  status: WriteOffStatus;
  amountPaise: Paise;
  rowVersion: number;
}

export interface WriteOffSwitchResult {
  changed: boolean;
  writeOffEnabled: boolean;
  writeOffLimitPaise: Paise;
  rowVersion: number;
  updatedAt: string | null;
}

export type WriteOffActionResult<T> =
  | { ok: true; data: T; message: string }
  | { ok: false; code: WriteOffErrorCode | 'session'; message: string; field?: string; values?: Record<string, string> };
