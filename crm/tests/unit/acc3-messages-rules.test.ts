import { describe, expect, it } from 'vitest';
// ASSUMPTION: export name — the frozen template list (contract 5.7).
import { CUSTOMER_MESSAGE_TEMPLATES } from '@/modules/customer-messages/templates';
// ASSUMPTION: export names — masks (contract 5.4 `to_masked`).
import { maskEmail, maskMobile } from '@/modules/customer-messages/masks';
// ASSUMPTION: export names — the pure mirror of quiet hours, retry times and skip order (contract 5.10 `rules.ts`).
import { QUIET_TYPES, RETRY_MINUTES, SKIP_ORDER, nextAttemptAt, notBeforeFor } from '@/modules/customer-messages/rules';

/**
 * Accounts phase 3, Track T (contract 16.2): customer message templates,
 * masks and the rules mirror. Written from contract 5.4, 5.5, 5.7, 5.9 and
 * LD5 — not from Track A's code. Synthetic values only.
 */

const TYPES = [
  'booking_confirmed', 'payment_received', 'hotel_voucher', 'e_ticket', 'boarding_pass', 'visa_status', 'trip_reminder', 'refund_paid',
  'booking_changed',
] as const;
type MsgType = (typeof TYPES)[number];
const LANGS = ['en', 'hi'] as const;

/** 5.5 params, in variable order: {{n}} = n-th param. */
const PARAMS: Record<MsgType, string[]> = {
  booking_confirmed: ['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd', 'travellerCount'],
  payment_received: ['customerName', 'dealReference', 'amountPaise', 'balancePaise'],
  hotel_voucher: ['customerName', 'dealReference', 'hotelName', 'checkIn', 'checkOut'],
  e_ticket: ['customerName', 'dealReference'],
  boarding_pass: ['customerName', 'dealReference'],
  visa_status: ['customerName', 'dealReference', 'travellerName', 'outcome'],
  trip_reminder: ['customerName', 'dealReference', 'destination', 'tripStart', 'daysLeft'],
  refund_paid: ['customerName', 'dealReference', 'amountPaise'],
  booking_changed: ['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd'],
};

/** 5.7 English texts, verbatim. */
const ENGLISH: Record<MsgType, string> = {
  booking_confirmed: 'Hello {{1}}, your booking {{2}} with Holiday Chacha is confirmed. Trip: {{3}}, {{4}} to {{5}}, {{6}} traveller(s). We will send your documents here.',
  payment_received: 'Hello {{1}}, we have received your payment of Rs {{3}} for booking {{2}}. Balance: Rs {{4}}. Thank you.',
  hotel_voucher: 'Hello {{1}}, your hotel voucher for {{3}} ({{4}} to {{5}}), booking {{2}}, is attached.',
  e_ticket: 'Hello {{1}}, your e-ticket for booking {{2}} is attached. Please check the names and dates.',
  boarding_pass: 'Hello {{1}}, your boarding pass for booking {{2}} is attached.',
  visa_status: 'Hello {{1}}, visa update for {{3}} on booking {{2}}: {{4}}. Your Holiday Chacha contact will call you with the next steps.',
  trip_reminder: 'Hello {{1}}, your trip to {{3}} (booking {{2}}) starts on {{4}} — {{5}} day(s) to go. Please keep your ID and tickets ready.',
  refund_paid: 'Hello {{1}}, we have paid your refund of Rs {{3}} for booking {{2}}. It may take a few working days to show in your account.',
  booking_changed: 'Hello {{1}}, your booking {{2}} has been updated. Trip: {{3}}, {{4}} to {{5}}. Your Holiday Chacha contact will share the details.',
};
const FOOTER = { en: 'Reply STOP to stop these messages', hi: 'ये संदेश बंद करने के लिए STOP लिखें' } as const;
const DOCUMENT_HEADER: MsgType[] = ['hotel_voucher', 'e_ticket', 'boarding_pass'];

type Tpl = { code: string; subject: string; body: string; header: string; footer?: string };

/**
 * ASSUMPTION (5.7 freezes the content, not the container): the list is either
 * a record type → language → template, or an array of entries carrying
 * `type` / `messageType` and `language` / `lang`. Either is accepted.
 */
function templateOf(type: MsgType, lang: 'en' | 'hi'): Tpl {
  const list = CUSTOMER_MESSAGE_TEMPLATES as unknown;
  if (Array.isArray(list)) {
    const hit = (list as Array<Record<string, unknown>>).find((t) => (t.type ?? t.messageType) === type && (t.language ?? t.lang) === lang);
    if (!hit) throw new Error(`missing template ${type}/${lang}`);
    return hit as unknown as Tpl;
  }
  const byType = (list as Record<string, Record<string, Tpl>>)[type];
  if (!byType?.[lang]) throw new Error(`missing template ${type}/${lang}`);
  return byType[lang];
}
const varsOf = (body: string) => [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
/** The WhatsApp text = body plus the footer (separate field or appended). */
const whatsappText = (t: Tpl) => (t.footer ? `${t.body}\n${t.footer}` : t.body);

describe('5.7 template list', () => {
  it('nine types × English and Hindi, each with a code tn_<type>_<lang>_v1, an e-mail subject and a WhatsApp body', () => {
    for (const type of TYPES) {
      for (const lang of LANGS) {
        const t = templateOf(type, lang);
        expect(t.code, `${type}/${lang}`).toBe(`tn_${type}_${lang}_v1`);
        expect(t.code).toMatch(/^tn_[a-z_]+_(en|hi)_v[0-9]+$/);
        expect(t.subject.trim().length, `${type}/${lang} e-mail subject`).toBeGreaterThan(0);
        expect(t.body.trim().length, `${type}/${lang} body`).toBeGreaterThan(0);
      }
    }
    const count = Array.isArray(CUSTOMER_MESSAGE_TEMPLATES) ? (CUSTOMER_MESSAGE_TEMPLATES as unknown[]).length
      : Object.values(CUSTOMER_MESSAGE_TEMPLATES as Record<string, object>).reduce((n, v) => n + Object.keys(v).length, 0);
    expect(count, 'no tenth message (no "bill ready")').toBe(18);
  });

  it('English bodies are exactly the 5.7 texts', () => {
    for (const type of TYPES) expect(templateOf(type, 'en').body.replace(/\n?Reply STOP to stop these messages$/, '').trim(), type).toBe(ENGLISH[type]);
  });

  it('variables are {{1}}..{{n}} with n = the 5.5 param count, in both languages, and Hindi uses the same set', () => {
    for (const type of TYPES) {
      const want = PARAMS[type].map((_, i) => i + 1);
      for (const lang of LANGS) {
        const vars = varsOf(templateOf(type, lang).body);
        expect([...new Set(vars)].sort((a, b) => a - b), `${type}/${lang}`).toEqual(want);
      }
      expect(varsOf(templateOf(type, 'hi').body).length, `${type} hi vs en count`).toBe(varsOf(templateOf(type, 'en').body).length);
    }
  });

  it('every WhatsApp template ends with the STOP footer of its language', () => {
    for (const type of TYPES) {
      for (const lang of LANGS) expect(whatsappText(templateOf(type, lang)).trimEnd().endsWith(FOOTER[lang]), `${type}/${lang}`).toBe(true);
    }
  });

  it('document header exactly for hotel voucher, e-ticket and boarding pass', () => {
    for (const type of TYPES) {
      for (const lang of LANGS) expect(templateOf(type, lang).header, `${type}/${lang}`).toBe(DOCUMENT_HEADER.includes(type) ? 'document' : 'none');
    }
  });

  it('utility rules: no offers, links, bills, ID numbers, supplier or cost words; amounts only in the two money types', () => {
    const forbidden = /(offer|discount|sale\b|free\b|% off|https?:|www\.|\.com\b|invoice|bill\b|passport|pan\b|aadhaar|supplier|margin|cost)/i;
    for (const type of TYPES) {
      for (const lang of LANGS) {
        const t = templateOf(type, lang);
        expect(`${t.subject} ${t.body}`, `${type}/${lang}`).not.toMatch(forbidden);
        expect(`${t.subject} ${t.body}`, `${type}/${lang} no literal digits besides variables`).not.toMatch(/(?<!\{\{)\b\d{3,}\b/);
      }
      if (type !== 'payment_received' && type !== 'refund_paid') expect(templateOf(type, 'en').body, type).not.toMatch(/\bRs\b/);
    }
  });
});

describe('5.4 masks', () => {
  it('mobile 60xxxxxx21 and e-mail p***@example.test; the full value never survives', () => {
    expect(maskMobile('6000054321')).toBe('60xxxxxx21');
    expect(maskMobile('6000012345')).toBe('60xxxxxx45');
    expect(maskEmail('pooja.synthetic@example.test')).toBe('p***@example.test');
    expect(maskEmail('p@example.test')).toBe('p***@example.test');
    expect(maskMobile('6000054321')).not.toContain('005432');
    expect(maskEmail('pooja.synthetic@example.test')).not.toContain('pooja');
  });
});

/** India time helper: an instant from an IST wall-clock time. */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);

describe('LD5 quiet hours mirror', () => {
  it('the five quiet types are exactly the contract list', () => {
    expect([...QUIET_TYPES].sort()).toEqual(['booking_changed', 'booking_confirmed', 'hotel_voucher', 'trip_reminder', 'visa_status']);
  });
  it('quiet types queued 21:00-08:00 India time wait for the next 08:00; others go now', () => {
    const cases: Array<[string, string, Date]> = [
      ['2026-11-13', '20:59', ist('2026-11-13', '20:59')],
      ['2026-11-13', '21:00', ist('2026-11-14', '08:00')],
      ['2026-11-13', '23:30', ist('2026-11-14', '08:00')],
      ['2026-11-14', '02:00', ist('2026-11-14', '08:00')],
      ['2026-11-14', '07:59', ist('2026-11-14', '08:00')],
      ['2026-11-14', '08:00', ist('2026-11-14', '08:00')],
      ['2026-11-14', '12:00', ist('2026-11-14', '12:00')],
    ];
    for (const [d, t, want] of cases) {
      for (const type of QUIET_TYPES) expect(new Date(notBeforeFor(type, ist(d, t))).toISOString(), `${type} ${d} ${t}`).toBe(want.toISOString());
    }
    for (const type of ['payment_received', 'refund_paid', 'e_ticket', 'boarding_pass']) {
      const at = ist('2026-11-13', '23:30');
      expect(new Date(notBeforeFor(type as never, at)).toISOString(), type).toBe(at.toISOString());
    }
  });
});

describe('5.9 retry mirror and 5.5 skip order', () => {
  it('three retries at +5, +20 and +60 minutes, then failed (attempts 0..4)', () => {
    expect([...RETRY_MINUTES]).toEqual([5, 20, 60]);
    const t0 = new Date('2026-11-13T06:00:00Z');
    // ASSUMPTION: nextAttemptAt(attemptsMadeSoFar, failedAt) → the next try, or null when it becomes `failed`;
    // the delays are counted from the failed attempt.
    expect(new Date(nextAttemptAt(1, t0)!).getTime() - t0.getTime()).toBe(5 * 60_000);
    expect(new Date(nextAttemptAt(2, t0)!).getTime() - t0.getTime()).toBe(20 * 60_000);
    expect(new Date(nextAttemptAt(3, t0)!).getTime() - t0.getTime()).toBe(60 * 60_000);
    expect(nextAttemptAt(4, t0)).toBeNull();
  });
  it('skip checks in the frozen order', () => {
    expect([...SKIP_ORDER]).toEqual([
      'test_deal', 'not_in_pilot', 'trip_cancelled', 'change_in_progress', 'channel_off_on_deal', 'no_contact', 'opted_out', 'template_not_approved',
    ]);
  });
});
