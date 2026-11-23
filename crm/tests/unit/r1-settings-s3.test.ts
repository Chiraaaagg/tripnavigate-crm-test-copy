import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import { BITRIX_TABS, bitrixTabHref, parseBitrixTab } from '@/views/integration-views';
import { messageSettingsTabHref, MESSAGE_SETTINGS_TABS, parseMessageSettingsTab, switchesSummary, whatsappBlockText } from '@/views/customer-messages/settings-tabs';
import type { AdminCustomerMessages } from '@/views/customer-messages/types';
import { importIndexRows, importKindHref, parseImportKind } from '@/views/settings/imports-index';

/*
 * UX redesign R1, helper S3: the sub-tab addresses of Bitrix connection and
 * Customer messages (old addresses keep opening the same page), the WhatsApp
 * block words without a language choice (D12), and the Imports index.
 */

describe('Bitrix connection sub-tabs', () => {
  it('the old address (no tab), unknown and repeated values open Status', () => {
    expect(parseBitrixTab(undefined)).toBe('status');
    expect(parseBitrixTab('')).toBe('status');
    expect(parseBitrixTab('Deals')).toBe('status');
    expect(parseBitrixTab('history')).toBe('status');
    expect(parseBitrixTab(['cleanup', 'deals'])).toBe('cleanup');
  });

  it('every sub-tab round-trips through its address; Status keeps the old address', () => {
    for (const tab of BITRIX_TABS) {
      const href = bitrixTabHref(tab);
      expect(href.startsWith('/app/admin/integration')).toBe(true);
      expect(parseBitrixTab(new URL(href, 'http://x').searchParams.get('tab') ?? undefined)).toBe(tab);
    }
    expect(bitrixTabHref('status')).toBe('/app/admin/integration');
  });
});

describe('Customer messages sub-tabs', () => {
  it('the old address opens Switches; texts, pilot and setup have their own address', () => {
    expect(parseMessageSettingsTab(undefined)).toBe('switches');
    expect(parseMessageSettingsTab('nope')).toBe('switches');
    expect(messageSettingsTabHref('switches')).toBe('/app/admin/customer-messages');
    for (const tab of MESSAGE_SETTINGS_TABS) {
      expect(parseMessageSettingsTab(new URL(messageSettingsTabHref(tab), 'http://x').searchParams.get('tab') ?? undefined)).toBe(tab);
    }
  });
});

const tpl = (type: 'e_ticket' | 'hotel_voucher', en: string, hi: string): AdminCustomerMessages['templates'] => [
  { templateCode: `tn_${type}_en_v1`, type, language: 'en', status: en as never, updatedAt: null },
  { templateCode: `tn_${type}_hi_v1`, type, language: 'hi', status: hi as never, updatedAt: null },
];

describe('WhatsApp block words (D12: English only, database rule A7 unchanged)', () => {
  it('switching off is never blocked', () => {
    expect(whatsappBlockText('e_ticket', tpl('e_ticket', 'not_submitted', 'not_submitted'), true)).toBeNull();
  });
  it('English text not approved: says so and points to Texts, without naming a language', () => {
    const text = whatsappBlockText('e_ticket', tpl('e_ticket', 'submitted', 'approved'), false);
    expect(text).toBe('WhatsApp has not approved this text yet. Set its status on the Texts tab.');
    expect(text).not.toMatch(/Hindi|English/);
  });
  it('only the unused second text is not approved: blocked, as the database would refuse', () => {
    const text = whatsappBlockText('hotel_voucher', tpl('hotel_voucher', 'approved', 'submitted'), false);
    expect(text).toMatch(/CRM team must remove that check/);
    expect(text).not.toMatch(/Hindi/);
  });
  it('both approved: no block', () => {
    expect(whatsappBlockText('hotel_voucher', tpl('hotel_voucher', 'approved', 'approved'), false)).toBeNull();
  });
  it('summary line', () => {
    const d = {
      switches: [
        { type: 'e_ticket', channel: 'email', enabled: true, rowVersion: 1 },
        { type: 'e_ticket', channel: 'whatsapp', enabled: false, rowVersion: 1 },
      ],
      pilotOnly: true,
      pilot: [{ dealId: 'x', dealReference: 'SYN-1', addedAt: '2026-11-01T00:00:00Z' }],
      timer: { enabled: false, lastOkAt: null, queueOldestMinutes: null },
    } as Pick<AdminCustomerMessages, 'switches' | 'pilotOnly' | 'pilot' | 'timer'>;
    expect(switchesSummary(d)).toBe('1 of 2 on · pilot list on (1 Deal) · timer off');
  });
});

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const viewer = (...roles: string[]) => ({ memberships: roles.map((roleCode) => ({ legalEntityId: ENTITY, roleCode })) }) as unknown as ViewerAccess;

describe('Imports index', () => {
  it('the address without ?kind= (or a value that is not a list) is the index; every old ?kind= still opens its list', () => {
    expect(parseImportKind(undefined)).toBe('index');
    expect(parseImportKind('nonsense')).toBe('index');
    expect(parseImportKind('hotel')).toBe('hotel');
    expect(parseImportKind('customer')).toBe('customer');
    expect(parseImportKind('supplier')).toBe('supplier');
    expect(parseImportKind('rate_sheet')).toBe('rate_sheet');
    expect(parseImportKind(['customer', 'hotel'])).toBe('customer');
  });

  it('Accounts: customers and suppliers first, hotels read only with the reason, no rate sheets', () => {
    const rows = importIndexRows(viewer('accounts'));
    expect(rows.map((r) => [r.kind, r.blockedText === null])).toEqual([
      ['customer', true],
      ['supplier', true],
      ['hotel', false],
    ]);
    expect(rows[2]!.blockedText).toBe('Only a Super Admin can import the hotel list.');
    expect(rows.map((r) => r.href)).toEqual([importKindHref('customer'), importKindHref('supplier'), importKindHref('hotel')]);
  });

  it('Super Admin: hotels, suppliers and rate sheets; customers read only', () => {
    const rows = importIndexRows(viewer('super_admin'));
    expect(rows.map((r) => r.kind)).toEqual(['hotel', 'supplier', 'rate_sheet', 'customer']);
    expect(rows.at(-1)!.blockedText).toBe('Only Accounts can import the customer list.');
  });

  it('Accounts who also hold Purchase: no list may be imported (the Purchase fence), rate sheets allowed', () => {
    const rows = importIndexRows(viewer('accounts', 'purchase'));
    expect(rows.find((r) => r.kind === 'customer')!.blockedText).not.toBeNull();
    expect(rows.find((r) => r.kind === 'rate_sheet')!.blockedText).toBeNull();
  });
});
