import { describe, expect, it } from 'vitest';
import { NOTICE_KINDS, type NoticeItemDTO, noticeText } from '@/modules/notices/contracts';
// ASSUMPTION: export name — the payload builder used by dispatchPush (contract 8.2).
import { buildPushPayload } from '@/modules/notices/server/push-dispatch';
// ASSUMPTION: export name and input shape — pure policy states (contract 8.4).
import { pushPolicyState } from '@/modules/notices/push-policy';

/**
 * Accounts phase 3, Track T (contract 16.2): the closed-browser alert payload
 * (8.2: reference-only, body = the bell text from noticeText) and the
 * push-policy states (8.4), plus the frozen templates of notices 40-46 (8.6)
 * and 50-60 (12). Written from the contract; synthetic sentinels only.
 */

const SENTINELS = {
  customerName: 'Sentinel Customer Name',
  mobile: '6000043210',
  email: 'sentinel.customer@example.test',
  amountPaise: '9123457',
  amountRupees: '91234.57',
  pnr: 'PNRSNT',
  ticketNumber: '0981234567890',
  messageText: 'Sentinel message body text',
};
const NOTICE_ID = '9b0e0f6a-1111-4111-8111-000000000001';

function item(kind: string, params: Record<string, unknown> = {}): NoticeItemDTO {
  return {
    noticeId: NOTICE_ID, seq: 1, kind: kind as never, priority: 'urgent', escalated: false, createdAt: '2026-11-13T06:00:00Z', readAt: null,
    doneAt: null, resolvedAt: null, resolvedReason: null, dealId: 'd0000000-0000-4000-8000-000000000001', dealReference: 'BX-1234',
    taskId: null, department: 'purchase', params: params as never, link: { kind: 'deal', id: 'd0000000-0000-4000-8000-000000000001' } as never,
  };
}

describe('8.2 push payload', () => {
  it('exactly {title, body, tag, url}; body = noticeText; tag tn-notice-<id>; url a same-origin path', () => {
    const n = item('task_new', { dealReference: 'BX-1234', department: 'purchase' });
    const p = buildPushPayload(n as never) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['body', 'tag', 'title', 'url']);
    expect(p.title).toBe('TripNavigate');
    expect(p.body).toBe(noticeText(n));
    expect(p.tag).toBe(`tn-notice-${NOTICE_ID}`);
    expect(String(p.url)).toMatch(/^\/(?!\/)/);
  });

  it('no customer name, phone, e-mail, amount, PNR, ticket number or message text for any kind, even with poisoned params', () => {
    const poisoned = {
      dealReference: 'BX-1234', department: 'flight', refNo: 'WO-2026-000001', serviceType: 'hotel', versionNo: 2, status: 'returned',
      ...SENTINELS, name: SENTINELS.customerName, phone: SENTINELS.mobile, to: SENTINELS.email, airlinePnr: SENTINELS.pnr, body: SENTINELS.messageText,
    };
    for (const kind of NOTICE_KINDS) {
      const p = buildPushPayload(item(kind, poisoned) as never);
      const t = JSON.stringify(p);
      for (const [key, value] of Object.entries(SENTINELS)) expect(t, `${kind} leaks ${key}`).not.toContain(value);
      expect(t, kind).not.toMatch(/₹|\bRs\b/);
    }
  });
});

/** Section 8.6 / 12 templates (references only). {BX} = BX-1234. */
describe('8.6 Release A notice templates (kinds 40-46)', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['bill_held', {}, 'BX-1234: a bill is held — check it'],
    ['write_off_to_approve', { refNo: 'WO-2026-000001' }, 'Write-off WO-2026-000001 on BX-1234 waiting for your approval'],
    ['write_off_decided', { refNo: 'WO-2026-000001', status: 'approved' }, 'Write-off WO-2026-000001 on BX-1234 approved'],
    ['write_off_decided', { refNo: 'WO-2026-000001', status: 'returned' }, 'Write-off WO-2026-000001 on BX-1234 returned'],
    ['write_off_decided', { refNo: 'WO-2026-000001', status: 'undone' }, 'Write-off WO-2026-000001 on BX-1234 undone'],
    ['message_failed', {}, 'BX-1234: a customer message could not be sent'],
    ['whatsapp_stopped', {}, 'BX-1234: the customer stopped WhatsApp messages'],
    ['boarding_pass_due', {}, 'BX-1234: boarding pass due — flight within 24 hours'],
    ['timer_stalled', {}, 'Background jobs are late — check the timer'],
  ];
  it('kinds are in the frozen list and render the frozen text', () => {
    for (const [kind, params, want] of cases) {
      expect(NOTICE_KINDS as readonly string[], kind).toContain(kind);
      expect(noticeText(item(kind, { dealReference: 'BX-1234', ...params })), `${kind} ${JSON.stringify(params)}`).toBe(want);
    }
  });
});

describe('12 Release B notice templates (kinds 50-60)', () => {
  // ASSUMPTION: CR / RC references travel in params.refNo, the decision in params.status and
  // the days of notice 60 in params.status (params keys are unchanged, 8.6).
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['change_to_approve', { refNo: 'CR-2026-000001' }, 'Change CR-2026-000001 on BX-1234 waiting for your approval'],
    ['change_decided', { refNo: 'CR-2026-000001', status: 'approved' }, 'Change CR-2026-000001 on BX-1234 approved'],
    ['change_decided', { refNo: 'CR-2026-000001', status: 'returned' }, 'Change CR-2026-000001 on BX-1234 returned'],
    ['reconfirm_supplier', {}, 'BX-1234: booking changed — reconfirm with the supplier'],
    ['change_not_possible', {}, 'BX-1234: the supplier could not make the change — the earlier booking stands'],
    ['reconfirm_undo', {}, 'BX-1234: the change is off — tell the supplier to keep the earlier booking'],
    ['removal_charges_to_enter', {}, 'BX-1234: a service is being removed — enter the supplier charges'],
    ['contract_to_approve', { refNo: 'RC-2026-000001' }, 'Rate contract RC-2026-000001 waiting for your approval'],
    ['contract_decided', { refNo: 'RC-2026-000001', status: 'approved' }, 'Rate contract RC-2026-000001 approved'],
    ['contract_decided', { refNo: 'RC-2026-000001', status: 'returned' }, 'Rate contract RC-2026-000001 returned'],
    ['contract_ending', { refNo: 'RC-2026-000001', status: '30' }, 'Rate contract RC-2026-000001 ends in 30 days'],
    ['contract_ending', { refNo: 'RC-2026-000001', status: '7' }, 'Rate contract RC-2026-000001 ends in 7 days'],
  ];
  it('kinds are in the frozen list and render the frozen text; 53 and 55 are not used', () => {
    for (const [kind, params, want] of cases) {
      expect(NOTICE_KINDS as readonly string[], kind).toContain(kind);
      expect(noticeText(item(kind, { dealReference: 'BX-1234', ...params })), `${kind} ${JSON.stringify(params)}`).toBe(want);
    }
  });
});

/**
 * ASSUMPTION: pushPolicyState({ supported, permission: 'default' | 'granted'
 * | 'denied', iphone, standalone, subscribed }) → state.
 */
describe('8.4 push-policy states', () => {
  const base = { supported: true, permission: 'default', iphone: false, standalone: false, subscribed: false };
  it('unsupported, needs_home_screen, blocked, off, on', () => {
    expect(pushPolicyState({ ...base, supported: false } as never)).toBe('unsupported');
    expect(pushPolicyState({ ...base, iphone: true, standalone: false } as never)).toBe('needs_home_screen');
    expect(pushPolicyState({ ...base, iphone: true, standalone: true } as never)).toBe('off');
    expect(pushPolicyState({ ...base, permission: 'denied' } as never)).toBe('blocked');
    expect(pushPolicyState({ ...base, permission: 'denied', subscribed: true } as never)).toBe('blocked');
    expect(pushPolicyState({ ...base } as never)).toBe('off');
    expect(pushPolicyState({ ...base, permission: 'granted', subscribed: false } as never)).toBe('off');
    expect(pushPolicyState({ ...base, permission: 'granted', subscribed: true } as never)).toBe('on');
    expect(pushPolicyState({ ...base, iphone: true, standalone: true, permission: 'granted', subscribed: true } as never)).toBe('on');
  });
});
