import { describe, expect, it } from 'vitest';
import { templateCodeParts } from '@/views/customer-messages/adapt';

describe('customer message template codes (contract 5.7)', () => {
  it('reads type and language from the frozen code', () => {
    expect(templateCodeParts('tn_booking_confirmed_hi_v1')).toEqual({ type: 'booking_confirmed', language: 'hi' });
    expect(templateCodeParts('tn_e_ticket_en_v2')).toEqual({ type: 'e_ticket', language: 'en' });
  });
  it('drops unknown or malformed codes', () => {
    expect(templateCodeParts('tn_bill_ready_en_v1')).toBeNull();
    expect(templateCodeParts('booking_confirmed_en')).toBeNull();
  });
});
