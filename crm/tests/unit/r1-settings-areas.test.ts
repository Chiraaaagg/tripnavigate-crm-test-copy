import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTab } from '@/lib/parse-tab';
import {
  currentSettingsTab,
  OVERVIEW_TEXT,
  SETTINGS_AREA_LINE,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_LABEL,
  SETTINGS_PATH,
  SETTINGS_ROLES_PATH,
  settingsAreaTarget,
  settingsHomeHref,
  settingsOverviewRows,
  settingsTabsFor,
  STAFF_PAGE_TABS,
  STAFF_STATUS_FILTERS,
  staffFailureWords,
  staffQueue,
  type SettingsViewerFlags,
} from '@/modules/settings/contracts';

/*
 * R1 Settings frame (helper S1): the area list per flag set, every old
 * Settings address still has its page and still marks its area, the
 * Overview rows (each failing on its own to "Not known"), the Staff queue
 * and the plain words for stored failure codes.
 */

const app = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src/app');
const pageFile = (href: string) => join(app, href.split('?')[0]!, 'page.tsx');

const ALL: SettingsViewerFlags = { canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canManageFinancePolicy: true, canImport: true };
const cats = (v: Partial<SettingsViewerFlags>) => settingsTabsFor(v).map((t) => t.category);

/** Every Settings address that existed before R1 (Batch 4 tabs, Accounts phase, Imports, Customer messages) and the area it belongs to. */
const OLD_ADDRESSES: Array<[string, string]> = [
  ['/app/admin/staff', 'people'],
  ['/app/admin/access', 'people'],
  ['/app/admin/company', 'company'],
  ['/app/admin/finance-policy', 'money'],
  ['/app/admin/accounts', 'accounts'],
  ['/app/admin/accounts/tally-mapping', 'accounts'],
  ['/app/admin/integration', 'bitrix'],
  ['/app/admin/workflow', 'features'],
  ['/app/admin/customer-messages', 'messages'],
  ['/app/admin/imports', 'imports'],
  ['/app/admin/bookings', 'health'],
];

describe('settings areas per flag set', () => {
  it('every area has one name and one line, in the design plan order', () => {
    expect(SETTINGS_CATEGORIES).toEqual(['overview', 'people', 'company', 'money', 'accounts', 'bitrix', 'features', 'messages', 'imports', 'health']);
    for (const c of SETTINGS_CATEGORIES) {
      expect(SETTINGS_CATEGORY_LABEL[c].length, c).toBeGreaterThan(0);
      expect(SETTINGS_AREA_LINE[c].length, c).toBeGreaterThan(0);
    }
    // D12: every customer message is in English; no language choice is named.
    expect(SETTINGS_AREA_LINE.messages).toContain('English');
  });

  it.each([
    ['Super Admin with every right', ALL, ['overview', 'people', 'company', 'money', 'accounts', 'bitrix', 'features', 'messages', 'imports', 'health']],
    ['staff admin only', { canAdministerStaff: true }, ['overview', 'people', 'company']],
    ['grants only', { canManageGrants: true }, ['overview', 'people', 'company']],
    ['money rules only', { canManageFinancePolicy: true }, ['overview', 'company', 'money', 'accounts']],
    ['integration manager without Purchase', { canManageIntegration: true, canOpenBitrixConnection: true }, ['overview', 'company', 'bitrix', 'features', 'messages', 'health']],
    ['integration manager holding Purchase', { canManageIntegration: true, canOpenBitrixConnection: false }, ['overview', 'company', 'features', 'messages', 'health']],
    ['integration manager, not a Super Admin (messages flag given)', { canManageIntegration: true, canOpenBitrixConnection: true, canOpenCustomerMessages: false }, ['overview', 'company', 'bitrix', 'features', 'health']],
    ['Accounts importer only', { canImport: true }, ['imports']],
    ['no right', {}, []],
  ] as Array<[string, Partial<SettingsViewerFlags>, string[]]>)('%s', (_name, flags, expected) => {
    expect(cats(flags)).toEqual(expected);
  });

  it('the Settings menu item opens Overview for anyone with an admin right, else their only area', () => {
    expect(settingsHomeHref(settingsTabsFor(ALL))).toBe('/app/admin');
    expect(settingsHomeHref(settingsTabsFor({ canAdministerStaff: true }))).toBe('/app/admin');
    expect(settingsHomeHref(settingsTabsFor({ canImport: true }))).toBe('/app/admin/imports');
    expect(settingsHomeHref(settingsTabsFor({}))).toBeNull();
  });

  it('the area picker goes only to one of the person’s own areas', () => {
    const tabs = settingsTabsFor({ canAdministerStaff: true });
    expect(settingsAreaTarget(tabs, '/app/admin/staff')).toBe('/app/admin/staff');
    expect(settingsAreaTarget(tabs, ['/app/admin/company', '/app/admin/staff'])).toBe('/app/admin/company');
    expect(settingsAreaTarget(tabs, '/app/admin/workflow')).toBeNull();
    expect(settingsAreaTarget(tabs, 'https://example.test/app/admin/staff')).toBeNull();
    expect(settingsAreaTarget(tabs, undefined)).toBeNull();
  });
});

describe('every old Settings address still opens its page', () => {
  it.each(OLD_ADDRESSES)('%s has its page file and marks the %s area', (href, area) => {
    expect(existsSync(pageFile(href)), `${href} page`).toBe(true);
    expect(currentSettingsTab(settingsTabsFor(ALL), href)).toBe(area);
  });

  it('every area link and the new Overview address have a page', () => {
    for (const href of Object.values(SETTINGS_PATH)) expect(existsSync(pageFile(href)), href).toBe(true);
    for (const t of settingsTabsFor(ALL)) expect(existsSync(pageFile(t.href)), t.href).toBe(true);
    expect(existsSync(pageFile(SETTINGS_ROLES_PATH)), SETTINGS_ROLES_PATH).toBe(true);
  });

  it('Overview is current only on its own address, never as the prefix of another area', () => {
    const tabs = settingsTabsFor(ALL);
    expect(currentSettingsTab(tabs, '/app/admin')).toBe('overview');
    expect(currentSettingsTab(tabs, '/app/admin?area=x')).toBe('overview');
    expect(currentSettingsTab(tabs, '/app/admin/not-a-page')).toBeUndefined();
  });

  it('Staff page ?tab= values: roles opens Roles and branches; anything else, old or unknown, is the Staff list', () => {
    expect(parseTab('roles', STAFF_PAGE_TABS, 'staff')).toBe('roles');
    for (const raw of [undefined, '', 'staff', 'access', 'invite', 'ROLES', ['x', 'roles']]) expect(parseTab(raw, STAFF_PAGE_TABS, 'staff'), String(raw)).toBe('staff');
    expect(parseTab('deactivated', STAFF_STATUS_FILTERS, 'all')).toBe('all');
    expect(parseTab('inactive', STAFF_STATUS_FILTERS, 'all')).toBe('inactive');
  });
});

describe('Overview rows', () => {
  const tabs = settingsTabsFor(ALL);

  it('one row per area except Overview, in area order, linking to the area', () => {
    const rows = settingsOverviewRows(tabs, {});
    expect(rows.map((r) => r.category)).toEqual(['people', 'company', 'money', 'accounts', 'bitrix', 'features', 'messages', 'imports', 'health']);
    for (const r of rows) expect(r.href).toBe(tabs.find((t) => t.category === r.category)!.href);
    // No read for the area: no badge, the area line.
    expect(rows.find((r) => r.category === 'accounts')).toMatchObject({ state: { tone: 'none' }, text: SETTINGS_AREA_LINE.accounts });
  });

  it('a failed read is Not known on its own row, never Off or 0', () => {
    const rows = settingsOverviewRows(tabs, { people: 'unknown', features: { on: 3, total: 5, unknown: 0 }, bitrix: { autoSync: 'unknown' } });
    expect(rows.find((r) => r.category === 'people')).toMatchObject({ state: { tone: 'unknown', label: OVERVIEW_TEXT.unknownState }, text: OVERVIEW_TEXT.unknownLine });
    expect(rows.find((r) => r.category === 'bitrix')!.state.tone).toBe('unknown');
    expect(rows.find((r) => r.category === 'features')).toMatchObject({ state: { tone: 'info', label: '3 of 5 on' } });
    for (const r of rows.filter((x) => x.state.tone === 'unknown')) {
      expect(r.state.label).toBe('Not known');
      expect(r.text).not.toMatch(/\b0\b/);
    }
  });

  it('states in words: invitations waiting, missing GSTIN, set-up not finished, real bookings off', () => {
    const rows = settingsOverviewRows(tabs, {
      people: { active: 14, invited: 2 },
      company: { missingGstin: ['Ahmedabad', 'Delhi'], notApproved: 0 },
      messages: { on: 4, total: 18, pilotOnly: true, pilotDeals: 2, keysMissing: 1 },
      health: { realBooking: 'off' },
      money: { on: 3, total: 4 },
    });
    const by = (c: string) => rows.find((r) => r.category === c)!;
    expect(by('people')).toMatchObject({ state: { tone: 'attention', label: 'Needs attention' }, text: '14 active staff members · 2 invitations not accepted yet' });
    expect(by('company').text).toBe('Ahmedabad and Delhi have no GSTIN yet: final PDFs there are blocked.');
    expect(by('messages')).toMatchObject({ state: { tone: 'attention', label: 'Set-up not finished' }, text: '4 of 18 on · pilot list on (2 Deals) · 1 sending key not saved yet' });
    expect(by('health')).toMatchObject({ state: { tone: 'off', label: 'Real bookings off' } });
    expect(by('money').state.label).toBe('3 of 4 on');
    expect(settingsOverviewRows(tabs, { people: { active: 1, invited: 0 } })[0]).toMatchObject({ state: { tone: 'ok', label: 'All set' }, text: '1 active staff member' });
  });

  it('a person sees rows only for their own areas', () => {
    expect(settingsOverviewRows(settingsTabsFor({ canAdministerStaff: true }), {}).map((r) => r.category)).toEqual(['people', 'company']);
  });
});

describe('Staff queue and failure words', () => {
  const rows = [
    { displayName: 'Asha Rao', email: 'asha@example.test', status: 'active' as const },
    { displayName: 'Ben Das', email: 'ben@example.test', status: 'invited' as const },
    { displayName: 'Chitra Sen', email: 'c.sen@example.test', status: 'inactive' as const },
  ];

  it('search by name or work e-mail in any case; counts follow the search; the chip filters the rows', () => {
    expect(staffQueue(rows, {}).counts).toEqual({ all: 3, invited: 1, active: 1, inactive: 1 });
    expect(staffQueue(rows, { q: 'BEN' }).rows.map((r) => r.displayName)).toEqual(['Ben Das']);
    expect(staffQueue(rows, { q: 'c.sen@' }).rows.map((r) => r.displayName)).toEqual(['Chitra Sen']);
    expect(staffQueue(rows, { q: 'example', status: 'invited' })).toEqual({ rows: [rows[1]], counts: { all: 3, invited: 1, active: 1, inactive: 1 } });
    expect(staffQueue(rows, { q: 'nobody' })).toEqual({ rows: [], counts: { all: 0, invited: 0, active: 0, inactive: 0 } });
  });

  it('plain words for every stored code shape; the raw code is never the sentence', () => {
    const cases: Array<[string | null, 'mail' | 'sign-in', RegExp]> = [
      ['smtp_rejected', 'mail', /mail service refused the message/],
      ['provider_unavailable:503', 'sign-in', /sign-in service was not available/],
      ['over_email_send_rate_limit:429', 'mail', /too many requests/],
      ['provider_outcome_unknown', 'mail', /not known whether it worked/],
      ['recipient_not_allowed', 'mail', /not allowed to e-mail that address/],
      ['recipient_unavailable', 'mail', /could not read this person’s work e-mail address/],
      ['plan_lookup:22023', 'sign-in', /did not match this recovery/],
      ['something_else', 'mail', /refused the request/],
      [null, 'mail', /gave no reason/],
    ];
    for (const [code, service, words] of cases) {
      const text = staffFailureWords(code, service);
      expect(text, String(code)).toMatch(words);
      if (code) expect(text).not.toContain(code);
    }
  });
});
