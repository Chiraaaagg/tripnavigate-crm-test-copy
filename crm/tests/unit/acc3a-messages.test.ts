import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MESSAGE_TYPES, LANGUAGES } from '@/modules/customer-messages/contracts';
import { AdminCustomerMessagesSchema } from '@/modules/customer-messages/dto';
import { notBeforeFor } from '@/modules/customer-messages/rules';
import { DISPATCH_LIMIT, DISPATCH_LEASE_SECONDS, dispatchCustomerMessages, type DispatchDeps } from '@/modules/customer-messages/server/dispatch';
import { fetchFailureReason, sendCustomerEmail } from '@/lib/email/customer-email';
import { sendWhatsAppTemplate } from '@/lib/whatsapp/interakt';
import { providerConfigured, templatePreviews } from '@/modules/customer-messages/server/queries';
import {
  handleInteraktWebhook,
  handleResendWebhook,
  normaliseMobile,
  parseInteraktEvent,
  parseResendEvent,
  type ProviderEvent,
} from '@/modules/customer-messages/server/webhooks';
import { CUSTOMER_MESSAGE_TEMPLATES, formatRupees, renderEmail, templateValues } from '@/modules/customer-messages/templates';

/**
 * Accounts phase 3, track A's own unit checks (contract 5.5, 5.7-5.9): text
 * rendering, the dispatcher with stub providers and storage, provider event
 * parsing and the webhook handlers. Track T's acc3-* suites are the
 * independent tests. No network: every provider is a stub.
 */

const ID = '7a1b2c3d-0000-4000-8000-00000000c0de';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const EV = '00000000-0000-4000-8000-0000000000e1';

describe('templates', () => {
  it('rupees from whole paise with Indian grouping, never a float', () => {
    expect(formatRupees('2500000')).toBe('25,000');
    expect(formatRupees('12345678950')).toBe('12,34,56,789.50');
    expect(formatRupees('5')).toBe('0.05');
  });

  it('values in variable order; outcome in the message language; missing = "-"', () => {
    expect(templateValues('visa_status', 'hi', { customerName: 'A', dealReference: 'SYN-1', travellerName: 'B', outcome: 'not_approved' }))
      .toEqual(['A', 'SYN-1', 'B', 'स्वीकृत नहीं']);
    expect(templateValues('payment_received', 'en', { customerName: 'A\nB', amountPaise: '100' })).toEqual(['A B', '-', '1', '-']);
  });

  it('e-mail: subject and body filled, HTML escaped, no STOP line', () => {
    const email = renderEmail('booking_confirmed', 'en', { customerName: '<b>A</b>', dealReference: 'SYN-1', destination: 'Goa',
      tripStart: '01 Dec 2026', tripEnd: '04 Dec 2026', travellerCount: '2' });
    expect(email.subject).toBe('Your booking SYN-1 is confirmed');
    expect(email.text).toContain('Trip: Goa, 01 Dec 2026 to 04 Dec 2026, 2 traveller(s).');
    expect(email.html).toContain('&lt;b&gt;A&lt;/b&gt;');
    expect(email.text).not.toContain('STOP');
  });

  it('previews: 18 for the settings page; provider flags are booleans from names only', () => {
    const previews = templatePreviews();
    expect(previews).toHaveLength(MESSAGE_TYPES.length * LANGUAGES.length);
    expect(previews.every((p) => !/\{\{\d+\}\}/.test(p.whatsappText) && p.whatsappText.endsWith(CUSTOMER_MESSAGE_TEMPLATES[p.type][p.language].footer)))
      .toBe(true);
    const flags = providerConfigured({ RESEND_API_KEY: 're_secret_value', INTERAKT_API_KEY: '' });
    expect(flags.find((f) => f.key === 'RESEND_API_KEY')!.configured).toBe(true);
    expect(flags.find((f) => f.key === 'INTERAKT_API_KEY')!.configured).toBe(false);
    expect(JSON.stringify(flags)).not.toContain('re_secret_value');
    expect(AdminCustomerMessagesSchema.shape.previews.safeParse(previews).success).toBe(true);
  });

  it('quiet-hours mirror', () => {
    const at = new Date('2026-11-13T22:30:00+05:30');
    expect(notBeforeFor('booking_changed', at).toISOString()).toBe(new Date('2026-11-14T08:00:00+05:30').toISOString());
    expect(notBeforeFor('e_ticket', at).toISOString()).toBe(at.toISOString());
  });
});

function deps(claimed: unknown[], over: Partial<DispatchDeps> = {}) {
  const completed: Array<[string, boolean, string | null, string | null]> = [];
  const released: string[][] = [];
  const sentEmail: unknown[] = [];
  const sentWa: unknown[] = [];
  const d: DispatchDeps = {
    worker: 'unit-worker',
    claim: async () => claimed,
    complete: async (id, _w, ok, providerId, code) => { completed.push([id, ok, providerId, code]); },
    sendEmail: async (m) => { sentEmail.push(m); return { ok: true, providerId: 'f0000000-0000-4000-8000-000000000001' }; },
    sendWhatsApp: async (m) => { sentWa.push(m); return { ok: true, providerId: 'wa-1' }; },
    readFile: async () => new TextEncoder().encode('%PDF-synthetic'),
    signedUrl: async (_b, _p, seconds) => `https://storage.example.test/sign?ttl=${seconds}`,
    release: async (ids) => { released.push(ids); },
    sleep: async () => undefined,
    ...over,
  };
  return { d, completed, sentEmail, sentWa, released };
}

const base = {
  type: 'hotel_voucher', language: 'en', templateCode: 'tn_hotel_voucher_en_v1', dealId: DEAL,
  params: { customerName: 'Synthetic Customer', dealReference: 'SYN-DEL-001', hotelName: 'Lake Hotel', checkIn: '01 Dec 2026', checkOut: '04 Dec 2026' },
  attachment: { source: 'purchase_evidence', id: EV, bucket: 'purchase-evidence', objectPath: 'e/t/x', fileName: 'voucher.pdf', mime: 'application/pdf' },
};

describe('dispatchCustomerMessages', () => {
  it('e-mail with the file as base64; WhatsApp with a 30-minute file link; both completed as sent', async () => {
    const { d, completed, sentEmail, sentWa } = deps([
      { ...base, id: ID, channel: 'email', to: 'customer@example.test', replyTo: 'sales@example.test' },
      { ...base, id: EV, channel: 'whatsapp', to: '6000012345', replyTo: null },
    ]);
    expect(await dispatchCustomerMessages(d)).toEqual({ claimed: 2, sent: 2, failed: 0, leftOver: 0 });
    expect(sentEmail[0]).toMatchObject({ messageId: ID, to: 'customer@example.test', replyTo: 'sales@example.test',
      attachments: [{ fileName: 'voucher.pdf', contentBase64: Buffer.from('%PDF-synthetic').toString('base64') }] });
    expect(sentWa[0]).toMatchObject({ messageId: EV, templateName: 'tn_hotel_voucher_en_v1', languageCode: 'en',
      bodyValues: ['Synthetic Customer', 'SYN-DEL-001', 'Lake Hotel', '01 Dec 2026', '04 Dec 2026'],
      headerValues: ['https://storage.example.test/sign?ttl=1800'], fileName: 'voucher.pdf' });
    expect(completed).toEqual([[ID, true, 'f0000000-0000-4000-8000-000000000001', null], [EV, true, 'wa-1', null]]);
  });

  it('an unreadable file (retryable) or a throw while sending (unknown) completes with a code; the batch goes on', async () => {
    const { d, completed } = deps([
      { ...base, id: ID, channel: 'email', to: 'customer@example.test', replyTo: null },
      { ...base, id: EV, channel: 'whatsapp', to: '6000012345', replyTo: null },
    ], {
      readFile: async () => null,
      sendWhatsApp: async () => { throw new Error('Synthetic Customer 6000012345'); },
    });
    expect(await dispatchCustomerMessages(d)).toEqual({ claimed: 2, sent: 0, failed: 2, leftOver: 0 });
    // A throw while sending may mean the request left: unknown, never retried automatically.
    expect(completed).toEqual([[ID, false, null, 'network'], [EV, false, null, 'unknown_outcome']]);
  });

  it('an unexpected claim answer throws a code, never data', async () => {
    const { d } = deps([{ id: 'x' }]);
    await expect(dispatchCustomerMessages(d)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('provider events', () => {
  it('Interakt: delivery by callbackData; STOP / START from an inbound text with the ISD number; the text is dropped', () => {
    const delivered = parseInteraktEvent({ type: 'message_api_delivered', data: { message: { id: 'wa-9', meta_data: { source_data: { callback_data: ID } } } } });
    expect(delivered).toEqual({ provider: 'interakt', providerEventId: 'message_api_delivered:wa-9', messageRef: ID, kind: 'delivered', errorCode: null, mobile: null });
    const failed = parseInteraktEvent({ type: 'message_api_failed', data: { message: { id: 'wa-9', channel_error_code: '131026' } } });
    expect(failed).toMatchObject({ kind: 'failed', errorCode: 'invalid_number', messageRef: 'wa-9' });
    const stop = parseInteraktEvent({ type: 'message_received', data: { message: { id: 'in-1', message: ' Stop ' }, customer: { channel_phone_number: '916000012345' } } });
    expect(stop).toEqual({ provider: 'interakt', providerEventId: 'message_received:in-1', messageRef: null, kind: 'inbound_stop', errorCode: null, mobile: '6000012345' });
    expect(JSON.stringify(stop)).not.toContain('Stop');
    expect(parseInteraktEvent({ type: 'account_update', data: { message: { id: 'x' } } })).toBeNull();
    expect(normaliseMobile('+91 60000 12345')).toBe('6000012345');
    expect(normaliseMobile('12345')).toBeNull();
  });

  it('Resend: kinds by type; the svix id is the event id', () => {
    expect(parseResendEvent('msg_1', { type: 'email.bounced', data: { email_id: 'f0000000-0000-4000-8000-000000000001' } }))
      .toEqual({ provider: 'resend', providerEventId: 'msg_1', messageRef: 'f0000000-0000-4000-8000-000000000001', kind: 'bounced', errorCode: 'bounced', mobile: null });
    expect(parseResendEvent('msg_2', { type: 'email.delivery_delayed', data: {} })).toBeNull();
  });
});

describe('webhook handlers', () => {
  const SECRET = 'synthetic-interakt-webhook-secret';
  const body = JSON.stringify({ type: 'message_received', data: { message: { id: 'in-2', message: 'STOP' }, customer: { channel_phone_number: '916000012345' } } });
  const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const post = (raw: string, headers: Record<string, string>) => new Request('http://127.0.0.1/api/integrations/interakt/webhook', { method: 'POST', body: raw, headers });

  it('Interakt: 401 and nothing stored on a bad signature; 200 and one event on a good one; 503 without a secret', async () => {
    const recorded: ProviderEvent[] = [];
    const record = async (e: ProviderEvent) => { recorded.push(e); };
    expect((await handleInteraktWebhook(post(body, { 'interakt-signature': 'sha256=00' }), { secret: SECRET, record })).status).toBe(401);
    expect((await handleInteraktWebhook(post(body, {}), { secret: SECRET, record })).status).toBe(401);
    expect(recorded).toEqual([]);
    expect((await handleInteraktWebhook(post(body, { 'interakt-signature': sign(body) }), { secret: undefined, record })).status).toBe(503);
    const ok = await handleInteraktWebhook(post(body, { 'interakt-signature': sign(body) }), { secret: SECRET, record });
    expect(ok.status).toBe(200);
    expect(recorded).toEqual([expect.objectContaining({ kind: 'inbound_stop', mobile: '6000012345' })]);
    const big = 'x'.repeat(70 * 1024);
    expect((await handleInteraktWebhook(post(big, { 'interakt-signature': sign(big) }), { secret: SECRET, record })).status).toBe(413);
  });

  it('Resend: a valid Svix signature records the event; a stale one is refused', async () => {
    const key = Buffer.from('synthetic-svix-key-0001');
    const secret = `whsec_${key.toString('base64')}`;
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'f0000000-0000-4000-8000-000000000001' } });
    const now = 1_800_000_000;
    const sig = (ts: number) => `v1,${createHmac('sha256', key).update(`msg_9.${ts}.${raw}`).digest('base64')}`;
    const req = (ts: number) => new Request('http://127.0.0.1/api/integrations/resend/webhook', {
      method: 'POST', body: raw, headers: { 'svix-id': 'msg_9', 'svix-timestamp': String(ts), 'svix-signature': sig(ts) } });
    const recorded: ProviderEvent[] = [];
    const record = async (e: ProviderEvent) => { recorded.push(e); };
    expect((await handleResendWebhook(req(now - 600), { secret, record, nowSeconds: now })).status).toBe(401);
    expect((await handleResendWebhook(req(now), { secret, record, nowSeconds: now })).status).toBe(200);
    expect(recorded).toEqual([expect.objectContaining({ provider: 'resend', providerEventId: 'msg_9', kind: 'delivered' })]);
  });
});

describe('no duplicate after an unclear send (backend review)', () => {
  it('only a failure before the request left is retryable; a timeout or reset is unknown_outcome', () => {
    expect(fetchFailureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('network');
    expect(fetchFailureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe('network');
    expect(fetchFailureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('unknown_outcome');
    expect(fetchFailureReason(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('unknown_outcome');
    expect(fetchFailureReason(new Error('anything else'))).toBe('unknown_outcome');
  });

  it('any 2xx answer is sent, even with an odd body (provider id null); Interakt result:false is rejected', async () => {
    const ok = (body: unknown, jsonThrows = false) => async () => ({ ok: true, status: 200, json: async () => { if (jsonThrows) throw new SyntaxError('x'); return body; } }) as unknown as Response;
    const email = { messageId: ID, to: 'c@example.test', replyTo: null, subject: 's', html: '<p>h</p>', text: 't' };
    expect(await sendCustomerEmail(email, { apiKey: 'k', fetchImpl: ok({ nope: true }) })).toEqual({ ok: true, providerId: null });
    expect(await sendCustomerEmail(email, { apiKey: 'k', fetchImpl: ok(null, true) })).toEqual({ ok: true, providerId: null });
    const wa = { messageId: ID, phoneNumber: '6000012345', templateName: 'tn_e_ticket_en_v1', languageCode: 'en' as const, bodyValues: ['A', 'B'] };
    expect(await sendWhatsAppTemplate(wa, { apiKey: 'k', fetchImpl: ok({ result: true }) })).toEqual({ ok: true, providerId: null });
    expect(await sendWhatsAppTemplate(wa, { apiKey: 'k', fetchImpl: ok({ result: false }) })).toEqual({ ok: false, reason: 'rejected' });
    const timeout = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
    expect(await sendWhatsAppTemplate(wa, { apiKey: 'k', fetchImpl: timeout })).toEqual({ ok: false, reason: 'unknown_outcome' });
  });

  it('dispatch claims at most 5 with a lease that covers them, and never starts a send late in the lease or after the budget', async () => {
    expect(DISPATCH_LIMIT).toBeLessThanOrEqual(5);
    expect(DISPATCH_LEASE_SECONDS * 1000).toBeGreaterThanOrEqual(DISPATCH_LIMIT * 20_000);
    let clock = 0;
    const rows = [0, 1, 2].map((i) => ({ ...base, id: `7a1b2c3d-0000-4000-8000-00000000c0d${i}`, channel: 'email', to: 'c@example.test', replyTo: null, attachment: null, type: 'e_ticket',
      templateCode: 'tn_e_ticket_en_v1', params: { customerName: 'A', dealReference: 'B' } }));
    const { d, completed } = deps(rows, {
      now: () => clock,
      sendEmail: async () => { clock += 60_000; return { ok: true, providerId: null }; },
    });
    expect(await dispatchCustomerMessages(d)).toEqual({ claimed: 3, sent: 2, failed: 0, leftOver: 1 });
    expect(completed.map((c) => c[2])).toEqual([null, null]);
    const aborted = new AbortController();
    aborted.abort();
    const again = deps(rows);
    expect(await dispatchCustomerMessages(again.d, aborted.signal)).toEqual({ claimed: 3, sent: 0, failed: 0, leftOver: 3 });
    // Rows never started are given back to the queue at once (customer_message_release).
    expect(again.released).toEqual([rows.map((r) => r.id)]);
  });
});

describe('lost lease (Addendum O3)', () => {
  it('after a successful send, complete is tried up to 3 times; a sent message counts as sent when one try lands', async () => {
    let tries = 0;
    const { d } = deps([{ ...base, id: ID, channel: 'whatsapp', to: '6000012345', replyTo: null }], {
      complete: async () => { tries += 1; if (tries < 3) throw new Error('database busy'); },
    });
    expect(await dispatchCustomerMessages(d)).toEqual({ claimed: 1, sent: 1, failed: 0, leftOver: 0 });
    expect(tries).toBe(3);
    let always = 0;
    const never = deps([{ ...base, id: ID, channel: 'whatsapp', to: '6000012345', replyTo: null }], {
      complete: async () => { always += 1; throw new Error('database down'); },
    });
    expect(await dispatchCustomerMessages(never.d)).toMatchObject({ sent: 0, failed: 1 });
    expect(always).toBe(3);
    expect(never.sentWa).toHaveLength(1);
  });
});
