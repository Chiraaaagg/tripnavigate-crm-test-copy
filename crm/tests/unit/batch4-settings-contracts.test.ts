import { describe, expect, it } from 'vitest';
import { currentHref, currentNavHref } from '@/components/NavLinks';
import {
  accountsDealDefaultTab,
  currentSettingsTab,
  parseAccountsDealTab,
  historyTabFor,
  parseTaskTab,
  SETTINGS_PATH,
  settingsTabsFor,
  tabHref,
  taskTabsFor,
  toLastChangeVM,
  toSwitchState,
  type LastChangeRecord,
  type SettingsViewerFlags,
} from '@/modules/settings/contracts';

/*
 * Batch 4 Step 0 (frozen contract): Settings tabs (DA-17, lead rulings D1/D3),
 * the "Settings" menu item staying current on every /app/admin page, Unknown
 * never read as Off or as "never changed", and the server allowlists for the
 * department task tabs (DA-16) and the Accounts deal page tabs (DA-15, D6).
 */

const NO_FLAGS: SettingsViewerFlags = {
  canAdministerStaff: false,
  canManageGrants: false,
  canManageIntegration: false,
  canOpenBitrixConnection: false,
  canManageFinancePolicy: false,
};
const ALL: SettingsViewerFlags = { canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canManageFinancePolicy: true };
const cats = (v: Partial<SettingsViewerFlags>) => settingsTabsFor(v).map((t) => t.category);

describe('settingsTabsFor: the Settings categories a person may open', () => {
  it('a Super Admin with every right gets the six categories in DA-17 order, at today’s addresses', () => {
    const tabs = settingsTabsFor(ALL);
    expect(tabs.map((t) => t.label)).toEqual(['People and access', 'Company and branches', 'Money rules', 'Bitrix connection', 'Features', 'System health']);
    expect(tabs.map((t) => t.href)).toEqual(['/app/admin/staff', '/app/admin/company', '/app/admin/finance-policy', '/app/admin/integration', '/app/admin/workflow', '/app/admin/bookings']);
  });

  it('nobody without an admin right gets a Settings tab (no menu item, no tab bar)', () => {
    expect(settingsTabsFor(NO_FLAGS)).toEqual([]);
    expect(settingsTabsFor({})).toEqual([]);
  });

  it('each right opens only its own categories; Company and branches comes with any admin right (D1)', () => {
    expect(cats({ canAdministerStaff: true })).toEqual(['people', 'company']);
    expect(cats({ canManageGrants: true })).toEqual(['people', 'company']);
    expect(cats({ canManageFinancePolicy: true })).toEqual(['company', 'money']);
    expect(cats({ canManageIntegration: true, canOpenBitrixConnection: true })).toEqual(['company', 'bitrix', 'features', 'health']);
  });

  it('voice-note batch: Imports comes with canImport only, after Bitrix connection, at /app/admin/imports', () => {
    expect(cats({ ...ALL, canImport: true })).toEqual(['people', 'company', 'money', 'bitrix', 'imports', 'features', 'health']);
    expect(settingsTabsFor({ canImport: true })).toEqual([{ category: 'imports', label: 'Imports', href: '/app/admin/imports', matchPrefixes: ['/app/admin/imports'] }]);
    expect(cats(ALL)).not.toContain('imports');
  });

  it('an integration manager who holds Purchase gets no Bitrix connection tab (the page refuses them)', () => {
    expect(cats({ canManageIntegration: true, canOpenBitrixConnection: false })).toEqual(['company', 'features', 'health']);
  });

  it('People and access opens Staff, or Extra access for someone who may only grant access', () => {
    expect(settingsTabsFor({ canAdministerStaff: true, canManageGrants: true })[0]).toMatchObject({ href: SETTINGS_PATH.staff, matchPrefixes: [SETTINGS_PATH.staff, SETTINGS_PATH.access] });
    expect(settingsTabsFor({ canManageGrants: true })[0]).toMatchObject({ href: SETTINGS_PATH.access, matchPrefixes: [SETTINGS_PATH.access] });
  });

  it('currentSettingsTab marks the tab of the page, including Extra access under People and access', () => {
    const tabs = settingsTabsFor(ALL);
    expect(currentSettingsTab(tabs, '/app/admin/access')).toBe('people');
    expect(currentSettingsTab(tabs, '/app/admin/staff')).toBe('people');
    expect(currentSettingsTab(tabs, '/app/admin/workflow')).toBe('features');
    expect(currentSettingsTab(tabs, '/app/admin/finance-policy')).toBe('money');
    expect(currentSettingsTab(tabs, '/app/admin/staffing')).toBeUndefined();
    expect(currentSettingsTab(tabs, '/app/deals')).toBeUndefined();
    expect(currentSettingsTab(tabs, null)).toBeUndefined();
  });
});

describe('currentNavHref: one "Settings" item current on every /app/admin page', () => {
  const items = [
    { href: '/app' },
    { href: '/app/deals' },
    { href: '/app/accounts' },
    { href: '/app/accounts/cash' },
    { href: '/app/admin/integration', activePrefix: '/app/admin' },
  ];

  it('the Settings item is current on any Settings address, whatever its own href', () => {
    for (const path of ['/app/admin/integration', '/app/admin/staff', '/app/admin/access', '/app/admin/company', '/app/admin/finance-policy']) {
      expect(currentNavHref(items, path), path).toBe('/app/admin/integration');
    }
  });

  it('other items keep the longest-match rule of currentHref', () => {
    expect(currentNavHref(items, '/app/accounts/cash')).toBe('/app/accounts/cash');
    expect(currentNavHref(items, '/app/accounts/deals/abc')).toBe('/app/accounts');
    expect(currentNavHref(items, '/app')).toBe('/app');
    expect(currentNavHref(items, '/app/administration')).toBeUndefined();
    expect(currentNavHref(items, '/app/access')).toBeUndefined();
    expect(currentNavHref(items, undefined)).toBeUndefined();
  });

  it('without activePrefix it answers exactly as currentHref', () => {
    const plain = ['/app', '/app/deals', '/app/purchase', '/app/purchase/suppliers'];
    for (const path of ['/app', '/app/deals/1/book', '/app/purchase/suppliers/s1', '/app/purchase/t1', '/app/leads']) {
      expect(currentNavHref(plain.map((href) => ({ href })), path), path).toBe(currentHref(plain, path));
    }
  });
});

describe('switch states and last change: Unknown is never Off, and never "nothing recorded"', () => {
  it('toSwitchState accepts only on and off', () => {
    expect(toSwitchState('on')).toBe('on');
    expect(toSwitchState('off')).toBe('off');
    for (const v of [undefined, null, true, false, 'ON', '', 'unknown']) expect(toSwitchState(v)).toBe('unknown');
  });

  const record: LastChangeRecord = { at: '2026-10-13T05:00:00Z', byName: 'Synthetic Admin', byYou: false, via: 'command', command: 'admin_set_workflow_setting', from: false, to: true, fields: ['service_items_enabled'], reason: 'Owner APPROVE 13 Oct' };

  it('maps a person, a system change, nothing recorded and a failed read to four different states', () => {
    expect(toLastChangeVM(record)).toEqual({ kind: 'person', at: record.at, byName: 'Synthetic Admin', byYou: false, reason: 'Owner APPROVE 13 Oct' });
    expect(toLastChangeVM({ ...record, byName: null, via: 'direct_sql', command: null, reason: null })).toEqual({ kind: 'system', at: record.at, reason: null });
    expect(toLastChangeVM(null)).toEqual({ kind: 'none' });
    expect(toLastChangeVM(undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('department task tabs (DA-16): server allowlist', () => {
  it('a status-only viewer (nothing beyond Details was read for them) gets no tab bar', () => {
    expect(taskTabsFor({ work: false, files: false, history: false })).toEqual([]);
  });

  it('tabs follow what was read, always in DA-16 order and starting with Details', () => {
    expect(taskTabsFor({ work: true, files: true, history: true })).toEqual(['details', 'work', 'files', 'history']);
    expect(taskTabsFor({ work: true, files: false, history: true })).toEqual(['details', 'work', 'history']);
    expect(taskTabsFor({ work: false, files: false, history: true })).toEqual(['details', 'history']);
  });

  it('History: a readable record always; not installed or failed only for Work/Files readers; null never (Echo-A L5)', () => {
    expect(historyTabFor({ events: [] }, false)).toBe(true);
    expect(historyTabFor(null, true)).toBe(false);
    for (const load of ['not_installed', 'error'] as const) {
      expect(historyTabFor(load, true)).toBe(true);
      expect(historyTabFor(load, false)).toBe(false);
    }
    // A status-only viewer whose History read failed still gets no tab bar.
    expect(taskTabsFor({ work: false, files: false, history: historyTabFor('error', false) })).toEqual([]);
  });

  it('a tab the viewer does not have, or anything unknown, opens Details', () => {
    const tabs = taskTabsFor({ work: true, files: true, history: false });
    expect(parseTaskTab('work', tabs)).toBe('work');
    expect(parseTaskTab(['files', 'work'], tabs)).toBe('files');
    expect(parseTaskTab('history', tabs)).toBe('details');
    expect(parseTaskTab('money', tabs)).toBe('details');
    expect(parseTaskTab(undefined, tabs)).toBe('details');
    expect(parseTaskTab('work', [])).toBe('details');
  });
});

describe('Accounts deal page tabs (DA-15, plan T1, lead ruling D6)', () => {
  it('opens the tab of the next action: receipts to verify, else billing and review, else receipts', () => {
    expect(accountsDealDefaultTab({ receiptsAwaitingVerification: 2, billingVerified: false, reviewWaiting: true })).toBe('receipts');
    expect(accountsDealDefaultTab({ receiptsAwaitingVerification: 0, billingVerified: false, reviewWaiting: false })).toBe('review');
    expect(accountsDealDefaultTab({ receiptsAwaitingVerification: 0, billingVerified: true, reviewWaiting: true })).toBe('review');
    expect(accountsDealDefaultTab({ receiptsAwaitingVerification: 0, billingVerified: true, reviewWaiting: false })).toBe('receipts');
  });

  it('accepts only the four tabs; anything else is the default', () => {
    for (const tab of ['money', 'review', 'receipts', 'documents'] as const) expect(parseAccountsDealTab(tab, 'review')).toBe(tab);
    expect(parseAccountsDealTab('history', 'review')).toBe('review');
    expect(parseAccountsDealTab(undefined, 'receipts')).toBe('receipts');
    expect(parseAccountsDealTab(['documents'], 'review')).toBe('documents');
  });

  it('tabHref keeps the bare address for the default tab', () => {
    expect(tabHref('/app/accounts/deals/d1', 'review', 'review')).toBe('/app/accounts/deals/d1');
    expect(tabHref('/app/accounts/deals/d1', 'documents', 'review')).toBe('/app/accounts/deals/d1?tab=documents');
  });
});
