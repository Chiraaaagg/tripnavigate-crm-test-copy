import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ASSUMPTION: export name — Resend adapter for customer e-mail (contract 5.7).
import { sendCustomerEmail } from '@/lib/email/customer-email';
// ASSUMPTION: export name — Interakt adapter (contract 5.7).
import { sendWhatsAppTemplate } from '@/lib/whatsapp/interakt';
// ASSUMPTION: export names — signature checks and the STOP / START classifier (contract 5.8).
import { classifyInbound, verifyInteraktSignature, verifyResendSignature } from '@/modules/customer-messages/server/webhooks';
import { DISPATCH_LEASE_SECONDS, DISPATCH_LIMIT, dispatchCustomerMessages } from '@/modules/customer-messages/server/dispatch';

/**
 * Accounts phase 3, Track T (contract 16.2): the two provider adapters with a
 * stubbed fetch, webhook signature checks and the STOP / START classifier.
 * Written from contract 5.4, 5.7 and 5.8. No test reaches the network: the
 * global fetch is replaced by a spy that fails the test if called.
 */

const MESSAGE_ID = '7a1b2c3d-0000-4000-8000-00000000c0de';
const RESEND_KEY = 're_synthetic_key_do_not_leak_0001';
const INTERAKT_KEY = 'synthetic-interakt-key-do-not-leak-0001';
const PROVIDER_ID = '4ef9a5a1-5b3c-4f1d-9c0b-6d2c0f9a1e77';
const ERROR_CODES = ['not_configured', 'rejected', 'provider_error', 'network', 'bad_response', 'bounced', 'invalid_number', 'expired',
  // Addendum L11: the request left and no answer came (never retried automatically).
  'unknown_outcome'];

type Call = { url: string; init: RequestInit };
/** 'throw' = failure after the request left (timeout / reset); 'refused' / 'lookup' = failure before it left (Addendum L11). */
function stub(response: { ok: boolean; status: number; body?: unknown; jsonThrows?: boolean } | 'throw' | 'refused' | 'lookup') {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (response === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (response === 'lookup') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        if (response.jsonThrows) throw new SyntaxError('not json');
        return response.body;
      },
      text: async () => JSON.stringify(response.body ?? null),
    } as unknown as Response;
  });
  return { calls, fetchImpl };
}
const reasonOf = (r: unknown) => {
  const o = r as Record<string, unknown>;
  return (o.reason ?? o.errorCode ?? o.code) as string | undefined;
};
const headerOf = (init: RequestInit, name: string) => {
  const h = init.headers as Record<string, string> | Headers;
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : null;
};

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('a unit test reached the real network');
  }) as never;
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = realFetch;
});

// ASSUMPTION: message shape { messageId, to, replyTo, subject, html, text, attachments? [{ fileName, contentBase64 }] }.
const EMAIL = {
  messageId: MESSAGE_ID, to: 'pooja.synthetic@example.test', replyTo: 'sales.delhi.a@example.test', subject: 'Your booking SYN-DEL-001 is confirmed',
  html: '<p>Hello Synthetic Customer</p>', text: 'Hello Synthetic Customer',
};

describe('5.7 Resend adapter (customer e-mail)', () => {
  it('posts to Resend with the fixed sender, reply-to the Sales owner and the message id as the idempotency key', async () => {
    const { calls, fetchImpl } = stub({ ok: true, status: 200, body: { id: PROVIDER_ID } });
    const r = await sendCustomerEmail(EMAIL as never, { apiKey: RESEND_KEY, fetchImpl } as never);
    expect(r).toMatchObject({ ok: true, providerId: PROVIDER_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headerOf(calls[0]!.init, 'Authorization')).toBe(`Bearer ${RESEND_KEY}`);
    expect(headerOf(calls[0]!.init, 'Idempotency-Key')).toBe(MESSAGE_ID);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.from).toBe('Holiday Chacha <notifications@holidaychacha.com>');
    expect(body.to).toEqual([EMAIL.to]);
    expect(body.reply_to ?? body.replyTo).toEqual(expect.anything());
    expect(String(body.reply_to ?? body.replyTo)).toContain(EMAIL.replyTo);
    expect(body).toHaveProperty('html');
    expect(body).toHaveProperty('text');
  });

  it('no reply-to when none is known (LD10: no Sales owner and no Manager)', async () => {
    const { calls, fetchImpl } = stub({ ok: true, status: 200, body: { id: PROVIDER_ID } });
    await sendCustomerEmail({ ...EMAIL, replyTo: null } as never, { apiKey: RESEND_KEY, fetchImpl } as never);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.reply_to ?? body.replyTo ?? null).toBeNull();
  });

  it('attachments go as base64', async () => {
    const { calls, fetchImpl } = stub({ ok: true, status: 200, body: { id: PROVIDER_ID } });
    const content = Buffer.from('%PDF-synthetic').toString('base64');
    await sendCustomerEmail({ ...EMAIL, attachments: [{ fileName: 'voucher.pdf', contentBase64: content }] } as never,
      { apiKey: RESEND_KEY, fetchImpl } as never);
    const body = JSON.parse(String(calls[0]!.init.body)) as { attachments: Array<Record<string, unknown>> };
    expect(JSON.stringify(body.attachments)).toContain(content);
  });

  it('error mapping to the 5.4 codes; missing key = not_configured without any call; the key never in a result or thrown text', async () => {
    const none = stub({ ok: true, status: 200, body: { id: PROVIDER_ID } });
    expect(reasonOf(await sendCustomerEmail(EMAIL as never, { apiKey: '', fetchImpl: none.fetchImpl } as never))).toBe('not_configured');
    expect(none.calls).toHaveLength(0);
    const cases: Array<[Parameters<typeof stub>[0], string]> = [
      [{ ok: false, status: 422, body: { message: 'invalid' } }, 'rejected'],
      [{ ok: false, status: 500, body: {} }, 'provider_error'],
      // Addendum L11: only a failure before the request left is `network` (retried); after it left: `unknown_outcome`.
      ['throw', 'unknown_outcome'],
      ['refused', 'network'],
      ['lookup', 'network'],
    ];
    for (const [resp, want] of cases) {
      const { fetchImpl } = stub(resp);
      let result: unknown;
      try {
        result = await sendCustomerEmail(EMAIL as never, { apiKey: RESEND_KEY, fetchImpl } as never);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(RESEND_KEY);
        throw e;
      }
      expect(reasonOf(result), JSON.stringify(resp)).toBe(want);
      expect(ERROR_CODES).toContain(reasonOf(result));
      expect(JSON.stringify(result)).not.toContain(RESEND_KEY);
    }
  });
});

// ASSUMPTION: message shape { messageId, phoneNumber, templateName, languageCode, bodyValues, headerValues?, fileName? }.
const WA = {
  messageId: MESSAGE_ID, phoneNumber: '6000012345', templateName: 'tn_hotel_voucher_en_v1', languageCode: 'en',
  bodyValues: ['Synthetic Customer', 'SYN-DEL-001', 'Synthetic Hotel', '2026-12-01', '2026-12-04'],
  headerValues: ['https://synthetic.supabase.test/storage/v1/object/sign/x?token=t'], fileName: 'voucher.pdf',
};

describe('Addendum L11: any 2xx answer is sent (provider id optional)', () => {
  it('Resend: a 2xx with an odd or unreadable body is sent', async () => {
    for (const resp of [{ ok: true, status: 200, jsonThrows: true }, { ok: true, status: 200, body: { nope: true } }]) {
      const { fetchImpl } = stub(resp);
      const r = await sendCustomerEmail(EMAIL as never, { apiKey: RESEND_KEY, fetchImpl } as never);
      expect((r as { ok: boolean }).ok, JSON.stringify(resp)).toBe(true);
    }
  });
  it('Interakt: a 2xx with an odd or unreadable body is sent', async () => {
    for (const resp of [{ ok: true, status: 201, jsonThrows: true }, { ok: true, status: 201, body: {} }]) {
      const { fetchImpl } = stub(resp);
      const r = await sendWhatsAppTemplate(WA as never, { apiKey: INTERAKT_KEY, fetchImpl } as never);
      expect((r as { ok: boolean }).ok, JSON.stringify(resp)).toBe(true);
    }
  });
});

describe('5.7 Interakt adapter (WhatsApp)', () => {
  it('posts the template message with Basic auth, +91, the message id as callbackData', async () => {
    const { calls, fetchImpl } = stub({ ok: true, status: 201, body: { result: true, id: 'interakt-synthetic-1' } });
    const r = await sendWhatsAppTemplate(WA as never, { apiKey: INTERAKT_KEY, fetchImpl } as never);
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.interakt.ai/v1/public/message/');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headerOf(calls[0]!.init, 'Authorization')).toBe(`Basic ${INTERAKT_KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> & { template: Record<string, unknown> };
    expect(body).toMatchObject({ countryCode: '+91', phoneNumber: '6000012345', callbackData: MESSAGE_ID, type: 'Template' });
    expect(body.template).toMatchObject({ name: 'tn_hotel_voucher_en_v1', languageCode: 'en', bodyValues: WA.bodyValues });
    expect(body.template.headerValues).toEqual(WA.headerValues);
  });

  it('no header values for a text-only template; languageCode hi for Hindi', async () => {
    const { calls, fetchImpl } = stub({ ok: true, status: 201, body: { result: true, id: 'interakt-synthetic-2' } });
    await sendWhatsAppTemplate({ ...WA, templateName: 'tn_trip_reminder_hi_v1', languageCode: 'hi', headerValues: undefined, fileName: undefined } as never,
      { apiKey: INTERAKT_KEY, fetchImpl } as never);
    const body = JSON.parse(String(calls[0]!.init.body)) as { template: Record<string, unknown> };
    expect(body.template.languageCode).toBe('hi');
    expect(body.template.headerValues ?? null).toBeNull();
  });

  it('error mapping; missing key = not_configured; the key never in a result or thrown text', async () => {
    const none = stub({ ok: true, status: 201, body: {} });
    expect(reasonOf(await sendWhatsAppTemplate(WA as never, { apiKey: '', fetchImpl: none.fetchImpl } as never))).toBe('not_configured');
    expect(none.calls).toHaveLength(0);
    const cases: Array<[Parameters<typeof stub>[0], string]> = [
      [{ ok: false, status: 400, body: { result: false, message: 'bad request' } }, 'rejected'],
      [{ ok: false, status: 503, body: {} }, 'provider_error'],
      ['throw', 'unknown_outcome'],
      ['refused', 'network'],
      ['lookup', 'network'],
      // Addendum L11: Interakt `result: false` stays rejected even on a 2xx.
      [{ ok: true, status: 200, body: { result: false, message: 'synthetic refusal' } }, 'rejected'],
    ];
    for (const [resp, want] of cases) {
      const { fetchImpl } = stub(resp);
      let result: unknown;
      try {
        result = await sendWhatsAppTemplate(WA as never, { apiKey: INTERAKT_KEY, fetchImpl } as never);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(INTERAKT_KEY);
        throw e;
      }
      expect(reasonOf(result), JSON.stringify(resp)).toBe(want);
      expect(JSON.stringify(result)).not.toContain(INTERAKT_KEY);
    }
  });
});

// ---------------------------------------------------------------------------
// 5.8 webhook signatures
// ---------------------------------------------------------------------------
const SVIX_SECRET_BYTES = randomBytes(24);
const SVIX_SECRET = `whsec_${SVIX_SECRET_BYTES.toString('base64')}`;
function svixSign(id: string, ts: number, body: string, key: Buffer = SVIX_SECRET_BYTES) {
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}
const RAW = JSON.stringify({ type: 'email.delivered', data: { email_id: PROVIDER_ID } });
const NOW = Math.floor(new Date('2026-11-13T06:00:00Z').getTime() / 1000);

/**
 * ASSUMPTION: verifyResendSignature({ id, timestamp, signature } (the three
 * svix-* header values), rawBody, secret, nowSeconds?) → boolean, and
 * verifyInteraktSignature(rawBody, signatureHeader, secret) → boolean with a
 * hex HMAC-SHA256 of the raw body (Track A confirms Interakt's header and
 * encoding; adjust the encoding line only).
 */
describe('5.8 Resend (Svix) signature', () => {
  const headers = (id: string, ts: number, sig: string) => ({ id, timestamp: String(ts), signature: sig });
  it('good signature passes; any change to body, id, timestamp or key fails', () => {
    expect(verifyResendSignature(headers('msg_1', NOW, svixSign('msg_1', NOW, RAW)), RAW, SVIX_SECRET, NOW)).toBe(true);
    expect(verifyResendSignature(headers('msg_1', NOW, `v1,bad v1,${svixSign('msg_1', NOW, RAW).slice(3)}`), RAW, SVIX_SECRET, NOW)).toBe(true);
    expect(verifyResendSignature(headers('msg_1', NOW, svixSign('msg_1', NOW, RAW)), `${RAW} `, SVIX_SECRET, NOW)).toBe(false);
    expect(verifyResendSignature(headers('msg_2', NOW, svixSign('msg_1', NOW, RAW)), RAW, SVIX_SECRET, NOW)).toBe(false);
    expect(verifyResendSignature(headers('msg_1', NOW, svixSign('msg_1', NOW, RAW, randomBytes(24))), RAW, SVIX_SECRET, NOW)).toBe(false);
    expect(verifyResendSignature(headers('msg_1', NOW, ''), RAW, SVIX_SECRET, NOW)).toBe(false);
    expect(verifyResendSignature(headers('msg_1', NOW, svixSign('msg_1', NOW, RAW)), RAW, '', NOW)).toBe(false);
  });
  it('stale (more than 5 minutes old or ahead) fails; a replay of an old valid delivery fails', () => {
    const old = NOW - 301;
    expect(verifyResendSignature(headers('msg_1', old, svixSign('msg_1', old, RAW)), RAW, SVIX_SECRET, NOW)).toBe(false);
    const ahead = NOW + 301;
    expect(verifyResendSignature(headers('msg_1', ahead, svixSign('msg_1', ahead, RAW)), RAW, SVIX_SECRET, NOW)).toBe(false);
    const edge = NOW - 299;
    expect(verifyResendSignature(headers('msg_1', edge, svixSign('msg_1', edge, RAW)), RAW, SVIX_SECRET, NOW)).toBe(true);
    // Replay: the same signed delivery an hour later.
    expect(verifyResendSignature(headers('msg_1', NOW, svixSign('msg_1', NOW, RAW)), RAW, SVIX_SECRET, NOW + 3600)).toBe(false);
  });
});

describe('5.8 Interakt HMAC-SHA256 signature', () => {
  const SECRET = 'synthetic-interakt-webhook-secret';
  const body = JSON.stringify({ type: 'message_api_delivered', data: { message: { callback_data: MESSAGE_ID } } });
  const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
  it('good passes; bad, missing, other secret or changed body fails', () => {
    expect(verifyInteraktSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyInteraktSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
    expect(verifyInteraktSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyInteraktSignature(body, '', SECRET)).toBe(false);
    expect(verifyInteraktSignature(body, null as never, SECRET)).toBe(false);
    expect(verifyInteraktSignature(body, sign(body), '')).toBe(false);
    expect(verifyInteraktSignature(body, 'zz', SECRET)).toBe(false);
  });
});

describe('5.8 STOP / START classifier', () => {
  it('STOP words in English and Hindi, any case and spacing; START restarts; anything else is other', () => {
    for (const t of ['STOP', 'stop', ' Stop ', 'unsubscribe', 'UNSUBSCRIBE', 'बंद', 'बंद करें', '  बंद करें  ', '\tstop\n']) {
      expect(classifyInbound(t), JSON.stringify(t)).toBe('inbound_stop');
    }
    for (const t of ['START', 'start', ' Start ', 'शुरू']) expect(classifyInbound(t), t).toBe('inbound_start');
    for (const t of ['stop please', 'please stop', 'stopped', 'restart', 'starting', '', 'hello', 'STOP!', 'बंद करो']) {
      expect(classifyInbound(t), JSON.stringify(t)).toBe('inbound_other');
    }
  });
});

// ---------------------------------------------------------------------------
// Addendum L11: dispatch lease — at most 5 per pass, lease 120 s, no send started with under 25 s of lease left
// ---------------------------------------------------------------------------
describe('Addendum L11 dispatch pass', () => {
  const claimed = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, channel: 'email', type: 'payment_received', language: 'en',
    templateCode: 'tn_payment_received_en_v1', params: { customerName: 'Synthetic Customer', dealReference: 'SYN-DEL-001', amountPaise: '100', balancePaise: '0' },
    attachment: null, dealId: MESSAGE_ID, to: 'customer@example.test', replyTo: null,
  }));
  function deps(rows: unknown[], clock: () => number, send: () => Promise<unknown>) {
    const calls = { claim: [] as Array<[number, number]>, complete: [] as Array<[string, boolean, string | null]> };
    return {
      calls,
      deps: {
        worker: 'acc3-unit',
        claim: async (_w: string, limit: number, lease: number) => { calls.claim.push([limit, lease]); return rows; },
        complete: async (id: string, _w: string, ok: boolean, _p: string | null, code: string | null) => { calls.complete.push([id, ok, code]); },
        sendEmail: send as never, sendWhatsApp: send as never, readFile: async () => null, signedUrl: async () => null, now: clock,
      },
    };
  }

  it('claims at most 5 with a 120 s lease', async () => {
    const { calls, deps: d } = deps(claimed(5), () => 0, async () => ({ ok: true, providerId: null }));
    const counts = await dispatchCustomerMessages(d as never);
    expect(DISPATCH_LIMIT).toBe(5);
    expect(DISPATCH_LEASE_SECONDS).toBe(120);
    expect(calls.claim).toEqual([[5, 120]]);
    expect(counts).toMatchObject({ claimed: 5, sent: 5 });
  });

  it('a send that throws is unknown_outcome (never retried); none starts with under 25 s of lease left', async () => {
    let t = 0;
    const { calls, deps: d } = deps(claimed(3), () => t, async () => { t += 100_000; throw new Error('mid-send failure'); });
    const counts = await dispatchCustomerMessages(d as never);
    expect(calls.complete[0]).toEqual([expect.any(String), false, 'unknown_outcome']);
    // After the first send the clock is 100 s into a 120 s lease: the rest wait for the lease to expire.
    expect(counts.leftOver).toBe(2);
  });
});
