import { describe, expect, it } from 'vitest';
import {
  NOTICE_KINDS,
  NOTICE_LINK_KINDS,
  NOTICE_TONE,
  PUSH_TEST_BODY,
  noticePopsUp,
  noticeText,
  type NoticeItemDTO,
  type NoticeKind,
  type NoticeLinkKind,
} from '@/modules/notices/contracts';
import { noticeHref } from '@/modules/notices/href';
import { deviceLabel, isAllowedPushEndpoint, isIphoneLike, isSafeNoticePath, pushPolicyState, vapidKeyBytes } from '@/modules/notices/push-policy';
import { buildPushPayload, buildTestPushPayload, dispatchPush, vapidFromEnv, type PushDispatchDeps } from '@/modules/notices/server/push-dispatch';
import { handlePushRequest } from '@/modules/notices/server/push-route';

/**
 * Accounts phase 3, track D: closed-browser alert payload (8.2), push-policy
 * states (8.4), the sender and the push route. Synthetic values only; no
 * network (the sender is a stub).
 */

const SENTINELS = [
  'Sentinel Customer Name', '6000043210', '6000012345', 'sentinel@example.test', '9123457', '91234.57', '₹', 'Rs ',
  'PNRSNT', '0981234567890', 'Sentinel message body', 'ABCDE1234F',
];
const ID = '9b0e0f6a-1111-4111-8111-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';

function item(kind: NoticeKind, params: Record<string, unknown>, link: NoticeLinkKind = 'deal', department: NoticeItemDTO['department'] = 'flight'): NoticeItemDTO {
  return {
    noticeId: ID, seq: 7, kind, priority: 'urgent', escalated: false, createdAt: '2026-11-13T06:00:00Z', readAt: null, doneAt: null,
    resolvedAt: null, resolvedReason: null, dealId: DEAL, dealReference: 'BX-1234', taskId: ID, department,
    params: params as NoticeItemDTO['params'], link: { kind: link, id: DEAL },
  };
}

describe('8.2 payload: the bell text only', () => {
  const poisoned = {
    dealReference: 'BX-1234', department: 'flight', refNo: 'WO-2026-000001', serviceType: 'flight', versionNo: 3, status: 'returned',
    customerName: SENTINELS[0], mobile: SENTINELS[1], whatsapp: SENTINELS[2], email: SENTINELS[3], amountPaise: SENTINELS[4],
    amount: SENTINELS[5], pnr: SENTINELS[8], ticket: SENTINELS[9], text: SENTINELS[10], pan: SENTINELS[11],
  };
  it('every kind x every link kind: {title, body, tag, url}, body = noticeText, no sentinel', () => {
    for (const kind of NOTICE_KINDS) {
      for (const link of NOTICE_LINK_KINDS) {
        const n = item(kind, poisoned, link);
        const p = buildPushPayload(n);
        expect(Object.keys(p).sort()).toEqual(['body', 'tag', 'title', 'url']);
        expect(p.title).toBe('TripNavigate');
        expect(p.body).toBe(noticeText(n));
        expect(p.tag).toBe(`tn-notice-${ID}`);
        expect(isSafeNoticePath(p.url), `${kind}/${link} ${p.url}`).toBe(true);
        const t = JSON.stringify(p);
        for (const s of SENTINELS) expect(t, `${kind} leaks ${s}`).not.toContain(s);
      }
    }
  });
  it('test alert payload is fixed', () => {
    expect(buildTestPushPayload(ID)).toEqual({ title: 'TripNavigate', body: PUSH_TEST_BODY, tag: `tn-test-${ID}`, url: '/app' });
  });
  it('a link that is not a same-origin path falls back to /app', () => {
    expect(isSafeNoticePath('//evil.example.test/x')).toBe(false);
    expect(isSafeNoticePath('https://evil.example.test')).toBe(false);
    expect(isSafeNoticePath('/\\evil')).toBe(false);
    expect(isSafeNoticePath('/app/deals/x?tab=services#customer-messages')).toBe(true);
  });
});

describe('8.6 Release A kinds: text, links, tone', () => {
  it('frozen texts', () => {
    const t = (kind: NoticeKind, params: Record<string, unknown> = {}) => noticeText(item(kind, { dealReference: 'BX-1234', ...params }));
    expect(t('bill_held')).toBe('BX-1234: a bill is held — check it');
    expect(t('write_off_to_approve', { refNo: 'WO-2026-000001' })).toBe('Write-off WO-2026-000001 on BX-1234 waiting for your approval');
    for (const s of ['approved', 'returned', 'undone']) {
      expect(t('write_off_decided', { refNo: 'WO-2026-000001', status: s })).toBe(`Write-off WO-2026-000001 on BX-1234 ${s}`);
    }
    expect(t('message_failed')).toBe('BX-1234: a customer message could not be sent');
    expect(t('whatsapp_stopped')).toBe('BX-1234: the customer stopped WhatsApp messages');
    expect(t('boarding_pass_due')).toBe('BX-1234: boarding pass due — flight within 24 hours');
    expect(t('timer_stalled')).toBe('Background jobs are late — check the timer');
  });
  it('links open the right page', () => {
    const h = (kind: NoticeKind, link: NoticeLinkKind) => noticeHref({ ...item(kind, {}, link) });
    // UX redesign R2: the documents and messages cards have their own Deal tabs.
    expect(h('bill_held', 'deal_documents')).toBe(`/app/deals/${DEAL}?tab=documents#customer-documents`);
    expect(h('message_failed', 'deal_messages')).toBe(`/app/deals/${DEAL}?tab=messages#customer-messages`);
    expect(h('write_off_to_approve', 'small_balances')).toBe('/app/accounts/small-balances?preset=to_approve');
    expect(h('write_off_decided', 'small_balances')).toBe('/app/accounts/small-balances');
    expect(h('boarding_pass_due', 'task')).toBe(`/app/flight/${DEAL}`);
    expect(h('timer_stalled', 'timer')).toBe('/app/admin/customer-messages?tab=setup');
  });
  it('urgent kinds pop up; 42 only when returned (stored urgent)', () => {
    expect(NOTICE_TONE.boarding_pass_due).toBe('urgent');
    expect(noticePopsUp({ kind: 'timer_stalled', priority: 'urgent' })).toBe(true);
    expect(noticePopsUp({ kind: 'write_off_decided', priority: 'urgent' })).toBe(true);
    expect(noticePopsUp({ kind: 'write_off_decided', priority: 'normal' })).toBe(false);
    expect(noticePopsUp({ kind: 'bill_held', priority: 'normal' })).toBe(false);
  });
});

describe('8.4 push-policy', () => {
  const base = { supported: true, permission: 'default' as const, iphone: false, standalone: false, subscribed: false };
  it('states', () => {
    expect(pushPolicyState({ ...base, supported: false })).toBe('unsupported');
    expect(pushPolicyState({ ...base, supported: false, iphone: true })).toBe('needs_home_screen');
    expect(pushPolicyState({ ...base, iphone: true })).toBe('needs_home_screen');
    expect(pushPolicyState({ ...base, permission: 'denied', subscribed: true })).toBe('blocked');
    expect(pushPolicyState({ ...base, permission: 'granted' })).toBe('off');
    expect(pushPolicyState({ ...base, permission: 'granted', subscribed: true })).toBe('on');
  });
  it('device words never carry the raw user agent', () => {
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    expect(deviceLabel(win)).toBe('Chrome on Windows');
    const iph = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(deviceLabel(iph)).toBe('Safari on iPhone');
    expect(isIphoneLike(iph)).toBe(true);
    expect(isIphoneLike('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5)).toBe(true);
    expect(deviceLabel('x')).toBe('Browser on this computer');
  });
  it('VAPID public key: 65-byte uncompressed point only', () => {
    const bytes = new Uint8Array(65);
    bytes[0] = 4;
    const b64 = Buffer.from(bytes).toString('base64url');
    expect(vapidKeyBytes(b64)?.length).toBe(65);
    expect(vapidKeyBytes('not a key')).toBeNull();
    expect(vapidKeyBytes(Buffer.from(new Uint8Array(65)).toString('base64url'))).toBeNull();
  });
  it('VAPID env: incomplete = not configured', () => {
    expect(vapidFromEnv({})).toBeNull();
    expect(vapidFromEnv({ VAPID_SUBJECT: 'mailto:ops@example.test', NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'B'.repeat(87), VAPID_PRIVATE_KEY: 'a'.repeat(43) }))
      .not.toBeNull();
  });
});

describe('8.4 sender (stubbed push service)', () => {
  const notice = { ...item('task_new', { dealReference: 'BX-1234', department: 'purchase' }, 'task', 'purchase') };
  const job = (jobId: string, extra: Record<string, unknown> = {}) => ({
    jobId, endpoint: 'https://fcm.googleapis.com/fcm/send/syn-1', p256dh: `B${'A'.repeat(86)}`, authKey: 'A'.repeat(22), test: false, urgent: true, notice, ...extra,
  });
  function deps(rows: unknown[], statuses: Record<string, number | null | 'ok'>) {
    const done: Array<{ id: string; ok: boolean; status: number | null }> = [];
    const sent: Array<{ payload: string; urgency: string }> = [];
    const d: PushDispatchDeps = {
      worker: 'w1',
      claim: async () => rows,
      complete: async (id, _w, ok, status) => void done.push({ id, ok, status }),
      send: async (target, payload, options) => {
        sent.push({ payload, urgency: options.urgency });
        const s = statuses[target.endpoint === 'https://fcm.googleapis.com/fcm/send/syn-1' ? 'x' : 'y'];
        return s === 'ok' ? { ok: true } : { ok: false, statusCode: s ?? null };
      },
    };
    return { d, done, sent };
  }
  it('sends, counts, completes; test alerts carry the fixed body', async () => {
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
    const { d, done, sent } = deps([job(ids[0]!), job(ids[1]!, { test: true, notice: null, urgent: true })], { x: 'ok' });
    expect(await dispatchPush(d)).toEqual({ claimed: 2, sent: 2, failed: 0, gone: 0 });
    expect(done.every((x) => x.ok)).toBe(true);
    expect(JSON.parse(sent[0]!.payload).body).toBe('New Purchase task on BX-1234');
    expect(JSON.parse(sent[1]!.payload).body).toBe(PUSH_TEST_BODY);
    expect(sent[0]!.urgency).toBe('high');
  });
  it('410 counts as gone; other failures pass the status on; no keys in the result', async () => {
    const { d, done } = deps([job('00000000-0000-4000-8000-00000000000c')], { x: 410 });
    const r = await dispatchPush(d);
    expect(r).toEqual({ claimed: 1, sent: 0, failed: 0, gone: 1 });
    expect(done[0]).toEqual({ id: '00000000-0000-4000-8000-00000000000c', ok: false, status: 410 });
    expect(JSON.stringify(r)).not.toContain('push.example.test');
  });
  it('an endpoint outside the allowlist is never sent to; failed without a retry', async () => {
    const id = '00000000-0000-4000-8000-00000000000d';
    const done: Array<{ ok: boolean; status: number | null; code: string | null | undefined }> = [];
    let sends = 0;
    const d: PushDispatchDeps = {
      worker: 'w1',
      claim: async () => [job(id, { endpoint: 'https://push.example.test/ep/2' })],
      complete: async (_id, _w, ok, status, code) => void done.push({ ok, status, code }),
      send: async () => ((sends += 1), { ok: true }),
    };
    expect(await dispatchPush(d)).toEqual({ claimed: 1, sent: 0, failed: 1, gone: 0 });
    expect(sends).toBe(0);
    expect(done).toEqual([{ ok: false, status: null, code: 'endpoint_not_allowed' }]);
  });
  it('not configured = skipped', async () => {
    expect(await dispatchPush(null)).toBeNull();
  });
  it('a bad claim answer throws a code', async () => {
    const { d } = deps([{ jobId: 'x' }], {});
    await expect(dispatchPush(d)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('Addendum O3 push endpoint allowlist', () => {
  it('only the browsers\' push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://FCM.googleapis.com:443/fcm/send/x',
    ]) expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc', 'https://push.example.test/ep/1', 'https://fcm.googleapis.com.evil.test/x',
      'https://evil.test/fcm.googleapis.com', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x',
      'https://push.services.mozilla.com/x', 'https://evilnotify.windows.com/x', 'https://web.push.apple.com.evil.test/x',
    ]) expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });
});

describe('push route', () => {
  const secret = 's'.repeat(40);
  const req = (auth?: string) => new Request('http://localhost/api/integrations/push', { method: 'POST', headers: auth ? { authorization: auth } : {} });
  it('503 without a secret, 401 on a bad bearer, two passes when good', async () => {
    let calls = 0;
    const deps = { secret, dispatch: async () => ((calls += 1), { claimed: 1, sent: 1, failed: 0, gone: 0 }), wait: async () => undefined };
    expect((await handlePushRequest(req(`Bearer ${secret}`), { ...deps, secret: undefined })).status).toBe(503);
    expect((await handlePushRequest(req('Bearer nope'), deps)).status).toBe(401);
    expect(calls).toBe(0);
    const ok = await handlePushRequest(req(`Bearer ${secret}`), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok', claimed: 2, sent: 2, failed: 0, gone: 0 });
  });
});
