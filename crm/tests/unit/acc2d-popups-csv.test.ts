import { describe, expect, it } from 'vitest';
import { CsvValuesSchema } from '@/modules/accounts-desk/commands';
import { CSV_COLUMNS, CSV_PHASE2_KEYS, TALLY_RECORD_KINDS, mappingMissing, tallyNameOk } from '@/modules/accounts-desk/contracts';
import { csvHeaderLine, csvLine, narration } from '@/modules/accounts-desk/csv';
import { NOTICE_KINDS, NOTICE_TEXT, NOTICE_TONE, type NoticeItemDTO, noticePopsUp, noticeText, noticeTone, popupsOnOf } from '@/modules/notices/contracts';
import { NoticeInboxSchema, NoticePreferencesSchema } from '@/modules/notices/dto';
import { noticeHref } from '@/modules/notices/href';
import { POPUP_SUMMARY_TAG, decidePopup, nextPoppedSeq, popupStateText, shouldAskPermission } from '@/modules/notices/popup-policy';
import { SOUND_DEFAULT_ON, decideSound } from '@/modules/notices/sound-policy';
import { parseNoticeInbox } from '@/modules/notices/validate';

/**
 * Accounts phase 2, Track D's own unit checks: pop-up policy (8.4, LD26,
 * 13.5), sound / pop-ups ON by default (8.5), new kinds' templates and
 * links (8.3, 8.6), the mapped CSV columns and narration (8.2), and the
 * mapping name rules (8.1).
 */

let n = 0;
const item = (over: Partial<NoticeItemDTO> = {}): NoticeItemDTO => {
  n += 1;
  return { noticeId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, seq: n, kind: 'trip_cancelled', priority: 'urgent', escalated: false,
    createdAt: new Date().toISOString(), readAt: null, doneAt: null, resolvedAt: null, resolvedReason: null,
    dealId: 'd0000000-0000-4000-8000-000000000001', dealReference: 'BX-1001', taskId: null, department: null, params: { dealReference: 'BX-1001' },
    link: { kind: 'cancellation', id: 'd0000000-0000-4000-8000-000000000001' }, ...over } as NoticeItemDTO;
};
const base = { popupsOn: true, permission: 'granted' as const, supported: true, isLeader: true, tabVisibleAndFocused: false, lastPoppedSeq: 0 };

describe('8.4 pop-up policy', () => {
  it('urgent only, newer than the cursor, unread; never on the first read', () => {
    const urgent = item();
    const normal = item({ kind: 'refund_payout_due', priority: 'normal' });
    const escalated = item({ kind: 'receipt_to_verify', priority: 'normal', escalated: true });
    const done = item({ doneAt: new Date().toISOString() });
    const d = decidePopup({ ...base, items: [urgent, normal, escalated, done] });
    expect(d).toMatchObject({ show: true, maxSeq: urgent.seq });
    if (d.show) {
      expect(d.popups).toEqual([{ tag: `tn-notice-${urgent.noticeId}`, body: 'BX-1001 trip cancelled — stop new work', href: '/app/deals/d0000000-0000-4000-8000-000000000001' }]);
    }
    expect(decidePopup({ ...base, items: [urgent], lastPoppedSeq: urgent.seq })).toEqual({ show: false, reason: 'nothing' });
    expect(decidePopup({ ...base, items: [urgent], lastPoppedSeq: null })).toEqual({ show: false, reason: 'first_load' });
  });

  it('not while the CRM tab is visible and focused (LD26); leader tab only; off, blocked or unsupported shows nothing', () => {
    const items = [item()];
    expect(decidePopup({ ...base, items, tabVisibleAndFocused: true })).toEqual({ show: false, reason: 'focused' });
    expect(decidePopup({ ...base, items, isLeader: false })).toEqual({ show: false, reason: 'not_leader' });
    expect(decidePopup({ ...base, items, popupsOn: false })).toEqual({ show: false, reason: 'off' });
    expect(decidePopup({ ...base, items, permission: 'denied' })).toEqual({ show: false, reason: 'no_permission' });
    expect(decidePopup({ ...base, items, permission: 'default' })).toEqual({ show: false, reason: 'no_permission' });
    expect(decidePopup({ ...base, items, supported: false })).toEqual({ show: false, reason: 'unsupported' });
  });

  it('more than 3 at once -> one summary pop-up; cursor never moves back', () => {
    const items = [item(), item(), item(), item()];
    const d = decidePopup({ ...base, items });
    expect(d).toEqual({ show: true, popups: [{ tag: POPUP_SUMMARY_TAG, body: '4 urgent notices', href: null }], maxSeq: items[3]!.seq });
    expect(decidePopup({ ...base, items: items.slice(0, 3) })).toMatchObject({ show: true });
    expect(nextPoppedSeq(50, 40, { show: false, reason: 'nothing' })).toBe(50);
    expect(nextPoppedSeq(null, 40, d)).toBe(40);
  });

  it('permission asked once per browser, only while on; denied never again; the button forces only from default', () => {
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'default', alreadyAsked: false })).toBe(true);
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'default', alreadyAsked: true })).toBe(false);
    expect(shouldAskPermission({ popupsOn: false, supported: true, permission: 'default', alreadyAsked: false })).toBe(false);
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'denied', alreadyAsked: false, force: true })).toBe(false);
    expect(shouldAskPermission({ popupsOn: false, supported: true, permission: 'default', alreadyAsked: true, force: true })).toBe(true);
    expect(shouldAskPermission({ popupsOn: true, supported: false, permission: 'default', alreadyAsked: false })).toBe(false);
    expect(popupStateText({ popupsOn: true, permission: 'granted' })).toBe(NOTICE_TEXT.popupsOn);
    expect(popupStateText({ popupsOn: true, permission: 'denied' })).toBe(NOTICE_TEXT.popupsBlocked);
    expect(popupStateText({ popupsOn: true, permission: 'unsupported' })).toBe(NOTICE_TEXT.popupsUnsupported);
  });

  it('13.5 table: urgent tone and pop-up for 8, 26, 27 returned, 35, 36, 37; silent for 27 approved, 28-33, 38', () => {
    for (const kind of ['trip_cancelled', 'refund_to_approve', 'cancellation_to_approve', 'flight_charges_to_enter', 'visa_cancel_decide'] as const) {
      expect(noticePopsUp({ kind, priority: 'urgent' }), kind).toBe(true);
    }
    expect(noticePopsUp({ kind: 'refund_decided', priority: 'urgent' })).toBe(true);
    expect(noticePopsUp({ kind: 'refund_shortfall', priority: 'urgent' })).toBe(true);
    expect(noticePopsUp({ kind: 'refund_decided', priority: 'normal' })).toBe(false);
    expect(noticeTone({ kind: 'refund_decided', priority: 'normal' })).toBe('none');
    for (const kind of ['refund_payout_due', 'refund_paid', 'document_to_release', 'document_to_check', 'credit_note_to_release',
      'supplier_refund_due', 'refund_to_request'] as const) {
      expect(NOTICE_TONE[kind], kind).toBe('none');
      expect(noticePopsUp({ kind, priority: 'normal' }), kind).toBe(false);
    }
    expect(noticePopsUp({ kind: 'receipt_to_verify', priority: 'normal' })).toBe(false);
  });
});

describe('8.5 sound and pop-ups ON by default', () => {
  it('defaults on; missing popupsOn reads ON in the server and browser parsers; preferences carry both keys', () => {
    expect(SOUND_DEFAULT_ON).toBe(true);
    const inbox = { enabled: true, unreadCount: 0, urgentCount: 0, latestSeq: null, soundOn: true, items: [] };
    expect(NoticeInboxSchema.parse(inbox).popupsOn).toBe(true);
    expect(parseNoticeInbox(inbox)?.popupsOn).toBe(true);
    expect(parseNoticeInbox({ ...inbox, popupsOn: false })?.popupsOn).toBe(false);
    expect(parseNoticeInbox({ ...inbox, popupsOn: 'no' })).toBeNull();
    expect(popupsOnOf(undefined)).toBe(true);
    expect(NoticePreferencesSchema.parse({ soundOn: false, popupsOn: false })).toEqual({ soundOn: false, popupsOn: false });
    // Sound still waits for the first click per page load.
    expect(decideSound({ soundOn: true, isLeader: true, audioUnlocked: false, lastPlayedAt: null, now: 1, items: [item()], lastSeenSeq: 0 }))
      .toEqual({ play: false, reason: 'locked' });
  });
});

describe('8.3 / 8.6 new kinds: templates and links', () => {
  it('12 new kinds (34 dropped); references only', () => {
    expect(NOTICE_KINDS).toHaveLength(54); // + Accounts phase 3: 40-46 (track D), 50-60 without 53 and 55 (track N)
    expect(NOTICE_KINDS).not.toContain('supplier_refund_to_verify');
    const p = { dealReference: 'BX-1001', refNo: 'RF-2026-000001', status: 'returned' };
    const t = (kind: NoticeItemDTO['kind']) => noticeText({ kind, params: p, dealReference: 'BX-1001', department: null });
    expect(t('refund_to_approve')).toBe('Refund RF-2026-000001 on BX-1001 waiting for your approval');
    expect(t('refund_decided')).toBe('Refund RF-2026-000001 on BX-1001 returned');
    expect(t('refund_payout_due')).toBe('Refund RF-2026-000001 approved — pay it out');
    expect(t('refund_paid')).toBe('Refund RF-2026-000001 on BX-1001 paid');
    expect(t('document_to_release')).toBe('BX-1001: a customer document is ready to release');
    expect(t('document_to_check')).toBe('BX-1001: a released document needs checking');
    expect(t('credit_note_to_release')).toBe('BX-1001: a credit note is ready to release');
    expect(t('supplier_refund_due')).toBe('BX-1001: supplier refunds expected');
    expect(t('cancellation_to_approve')).toBe('Trip cancellation on BX-1001 waiting for your approval');
    expect(t('flight_charges_to_enter')).toBe('BX-1001 trip cancelled — enter the airline charges');
    expect(t('visa_cancel_decide')).toBe('BX-1001 trip cancelled — decide on submitted visa applications');
    expect(t('refund_to_request')).toBe('BX-1001 cancellation approved — request the refund');
    expect(t('refund_shortfall')).toBe('BX-1001: a reversed payment leaves the customer owing after a refund');
  });

  it('links open the right screen', () => {
    const id = 'e0000000-0000-4000-8000-000000000001';
    const dealId = 'd0000000-0000-4000-8000-000000000001';
    const href = (kind: NoticeItemDTO['kind'], link: NoticeItemDTO['link']) => noticeHref({ kind, link, dealId, department: null, dealReference: 'BX-1001' });
    expect(href('refund_to_approve', { kind: 'refund', id })).toBe('/app/approvals?tab=refunds');
    expect(href('refund_payout_due', { kind: 'refund', id })).toBe('/app/accounts/refunds');
    expect(href('refund_paid', { kind: 'refund', id })).toBe(`/app/deals/${dealId}#refund`);
    expect(href('document_to_release', { kind: 'customer_document', id })).toBe('/app/accounts/documents?dealReference=BX-1001');
    expect(href('supplier_refund_due', { kind: 'supplier_refund', id })).toBe('/app/accounts/refunds');
    expect(href('cancellation_to_approve', { kind: 'cancellation', id })).toBe('/app/approvals');
    expect(href('trip_cancelled', { kind: 'cancellation', id: dealId })).toBe(`/app/deals/${dealId}`);
  });
});

describe('8.2 CSV and 8.1 mapping rules', () => {
  it('mapped columns follow "Credit ledger hint"; new kinds; old lines without them give empty cells', () => {
    const keys = CSV_COLUMNS.map((c) => c.key) as string[];
    const at = keys.indexOf('creditLedger');
    expect(keys.slice(at + 1, at + 8)).toEqual([...CSV_PHASE2_KEYS]);
    expect(csvHeaderLine()).toContain('Credit ledger hint,Service,Tally debit ledger,Tally credit ledger,Tally voucher type,Mapping missing,Narration,Tally number,Amount (INR)');
    expect(TALLY_RECORD_KINDS).toEqual(expect.arrayContaining(['customer_document', 'supplier_refund']));
    const old = Object.fromEntries(CSV_COLUMNS.filter((c) => !(CSV_PHASE2_KEYS as readonly string[]).includes(c.key)).map((c) => [c.key, null]));
    const parsed = CsvValuesSchema.parse(old);
    expect(parsed.narration).toBeNull();
    expect(csvLine(parsed).split(',')).toHaveLength(CSV_COLUMNS.length);
  });

  it('narration has the Deal ID first and no names; formula-unsafe ledger names are refused', () => {
    expect(narration({ deal: 'BX-101', bitrixDealId: '10101', recordType: 'Customer invoice', reference: '10101-INV-1' }))
      .toBe('Deal 10101 | BX-101 | Customer invoice 10101-INV-1');
    expect(narration({ deal: 'BX-101', bitrixDealId: null, recordType: 'Receipt', reference: 'R-2026-27-000001' }))
      .toBe('Deal BX-101 | BX-101 | Receipt R-2026-27-000001');
    expect(narration({ deal: null, recordType: 'Cash deposit', reference: null })).toBe('Cash deposit');
    expect(tallyNameOk('Hotel Booking', 100)).toBe(true);
    for (const bad of ['=SUM(A1)', '+1', '-x', '@x', ' padded', 'tab\there', '']) expect(tallyNameOk(bad, 100), bad).toBe(false);
    expect(tallyNameOk('x'.repeat(61), 60)).toBe(false);
    expect(mappingMissing({ debitLedger: null, creditLedger: 'Hotel Booking', voucherType: 'Hotel Invoice' })).toBe(false);
    expect(mappingMissing({ debitLedger: null, creditLedger: null, voucherType: 'Receipt' })).toBe(true);
    expect(mappingMissing({ debitLedger: 'Bank', creditLedger: null, voucherType: null })).toBe(true);
  });
});
