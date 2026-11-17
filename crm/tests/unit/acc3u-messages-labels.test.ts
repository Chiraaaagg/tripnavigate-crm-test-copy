import { describe, expect, it } from 'vitest';
import {
  ERROR_TEXT,
  QUIET_HOURS_TYPES,
  SEND_STATE_WORD,
  SKIP_REASON_TEXT,
  TEMPLATE_STATUS_WORD,
  TYPE_LABEL,
  boardingPassDue,
  messageStatusAt,
  messageStatusWord,
  queueAgeText,
  whatsappSwitchBlock,
} from '@/views/customer-messages/labels';
import { MESSAGE_TYPES, type AdminCustomerMessages, type CustomerMessageRow } from '@/views/customer-messages/types';

/**
 * Accounts phase 3 contract §5 and §15 screens 1–4, track U: the pure
 * helpers behind the customer-messages screens (status words, WhatsApp
 * switch block, boarding-pass due rule, queue age).
 */

const row = (over: Partial<CustomerMessageRow>): CustomerMessageRow => ({
  id: 'm1',
  type: 'booking_confirmed',
  channel: 'email',
  language: 'en',
  status: 'queued',
  skipReason: null,
  createdAt: '2026-11-13T01:00:00Z',
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  errorCode: null,
  toMasked: null,
  attachmentKind: null,
  resendOf: null,
  can: { resend: false },
  ...over,
});

describe('customer message status words', () => {
  it('maps every status to a word with a tone (never colour alone)', () => {
    expect(messageStatusWord(row({ status: 'queued' })).label).toBe('Waiting');
    expect(messageStatusWord(row({ status: 'sending' })).label).toBe('Waiting');
    expect(messageStatusWord(row({ status: 'sent' })).label).toBe('Sent');
    expect(messageStatusWord(row({ status: 'delivered' })).label).toBe('Delivered');
    expect(messageStatusWord(row({ status: 'read' })).label).toBe('Read');
    // Addendum L11: no answer from the provider; never retried by itself.
    expect(messageStatusWord(row({ status: 'unknown', errorCode: 'unknown_outcome' }))).toEqual({ label: 'Failed — check before sending again', tone: 'danger' });
  });
  it('adds the reason to failed, skipped and stopped', () => {
    expect(messageStatusWord(row({ status: 'failed', errorCode: 'invalid_number' })).label).toBe('Failed — the number is not on WhatsApp');
    expect(messageStatusWord(row({ status: 'skipped', skipReason: 'not_in_pilot' })).label).toBe('Skipped — this Deal is not on the pilot list');
    expect(messageStatusWord(row({ status: 'stopped', skipReason: 'opted_out' })).label).toBe('Stopped — the customer replied STOP');
    expect(messageStatusWord(row({ status: 'failed' })).tone).toBe('danger');
  });
  it('has words for every skip reason, error code, send state and template status', () => {
    expect(Object.keys(SKIP_REASON_TEXT)).toHaveLength(10); // nine of contract 5.4 plus track A's switched_off
    expect(Object.keys(ERROR_TEXT)).toHaveLength(9); // contract 5.4 plus unknown_outcome (Addendum L11)
    expect(Object.keys(SEND_STATE_WORD).sort()).toEqual(['failed', 'not_sent', 'off', 'sent', 'waiting']);
    expect(Object.keys(TEMPLATE_STATUS_WORD)).toHaveLength(4);
  });
  it('names all nine types and five quiet-hours types', () => {
    expect(MESSAGE_TYPES).toHaveLength(9);
    for (const t of MESSAGE_TYPES) expect(TYPE_LABEL[t]).toBeTruthy();
    expect([...QUIET_HOURS_TYPES].sort()).toEqual(['booking_changed', 'booking_confirmed', 'hotel_voucher', 'trip_reminder', 'visa_status']);
  });
  it('never puts an amount or rupee sign in the words', () => {
    const all = [...Object.values(SKIP_REASON_TEXT), ...Object.values(ERROR_TEXT), ...Object.values(TYPE_LABEL)].join(' ');
    expect(all).not.toMatch(/₹|Rs\b|\d/);
  });
  it('shows the time of the latest step', () => {
    expect(messageStatusAt(row({ status: 'read', readAt: '2026-11-13T05:00:00Z' }))).toBe('2026-11-13T05:00:00Z');
    expect(messageStatusAt(row({ status: 'failed', failedAt: '2026-11-13T04:00:00Z' }))).toBe('2026-11-13T04:00:00Z');
    expect(messageStatusAt(row({ status: 'skipped' }))).toBe('2026-11-13T01:00:00Z');
  });
});

describe('WhatsApp switch block', () => {
  const tpl = (status: 'approved' | 'submitted', hi: 'approved' | 'submitted'): AdminCustomerMessages['templates'] => [
    { templateCode: 'tn_e_ticket_en_v1', type: 'e_ticket', language: 'en', status, updatedAt: null },
    { templateCode: 'tn_e_ticket_hi_v1', type: 'e_ticket', language: 'hi', status: hi, updatedAt: null },
  ];
  it('blocks turning on until both languages are approved', () => {
    expect(whatsappSwitchBlock('e_ticket', tpl('approved', 'submitted'), false)).toBe('WhatsApp has not approved the Hindi text yet.');
    expect(whatsappSwitchBlock('e_ticket', tpl('submitted', 'submitted'), false)).toBe('WhatsApp has not approved the English and Hindi text yet.');
    expect(whatsappSwitchBlock('e_ticket', [], false)).toMatch(/English and Hindi/);
    expect(whatsappSwitchBlock('e_ticket', tpl('approved', 'approved'), false)).toBeNull();
  });
  it('never blocks turning off', () => {
    expect(whatsappSwitchBlock('e_ticket', [], true)).toBeNull();
  });
});

describe('boarding pass due', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  it('is due within 24 hours of departure when no file is stored', () => {
    expect(boardingPassDue('2026-11-14T09:59:00Z', false, now)).toBe(true);
    expect(boardingPassDue('2026-11-14T10:00:00Z', false, now)).toBe(true);
    expect(boardingPassDue('2026-11-14T10:01:00Z', false, now)).toBe(false);
  });
  it('is not due once stored, after departure or for a bad date', () => {
    expect(boardingPassDue('2026-11-13T20:00:00Z', true, now)).toBe(false);
    expect(boardingPassDue('2026-11-13T09:00:00Z', false, now)).toBe(false);
    expect(boardingPassDue('not a date', false, now)).toBe(false);
  });
});

describe('queue age', () => {
  it('says the oldest waiting time in plain words', () => {
    expect(queueAgeText(null)).toBe('No messages waiting');
    expect(queueAgeText(0)).toBe('Oldest waiting message: under a minute');
    expect(queueAgeText(22)).toBe('Oldest waiting message: 22 min');
    expect(queueAgeText(135)).toBe('Oldest waiting message: 2 h 15 min');
  });
});
