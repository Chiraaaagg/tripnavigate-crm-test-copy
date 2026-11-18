import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsSwitchStates } from '@/modules/access/settings-state';
import { bitrixPageModel, featuresPageModel } from '@/modules/settings/server/queries';
import { SettingsSectionView } from '@/views/settings/setting-rows';
import { SETTINGS_TEXT, SWITCH_WORDS } from '@/modules/settings/text';
import { budgetText } from '@/views/purchase-views';
import { FeaturesSettingsView } from '@/views/workflow-views';

/*
 * Factual screen text (15 October 2026 audit; Batch 4: the Workflow switches
 * page is Settings · Features): the page names the real switches and claims no
 * default, a switch that was not read shows Unknown (never Off) and offers no
 * change form, and a Purchase budget never entered reads "Budget not set", not
 * an approved ₹0.00.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => '/app/admin/workflow' }));

const actions = { change: async () => ({ ok: true }) as never, previewVisa: async () => ({ state: 'uncounted', lines: [], canConfirm: false }) as never };
type Key = 'service_items_enabled' | 'intake_prompt_enabled' | 'visa_passport_tasks_enabled' | 'prefill_auto_fill' | 'referral_drafts';
const states = (switches: Partial<Record<Key, 'on' | 'off'>>): SettingsSwitchStates => ({
  workflow: { readable: true, canSwitch: true, switches: Object.entries(switches).map(([key, state]) => ({ key: key as Key, state: state!, lastChange: null })) },
  bitrix: null,
  live: null,
});
const render = (s: SettingsSwitchStates) => renderToStaticMarkup(createElement(FeaturesSettingsView, { model: featuresPageModel(s), actions, bitrixHref: null }));
const changeButtons = (html: string) => html.match(/>Change [^<]+</g) ?? [];

describe('Settings · Features (was the Workflow switches page)', () => {
  it('every switch is named and nothing claims a default state', () => {
    const html = render(states({ service_items_enabled: 'on', intake_prompt_enabled: 'off', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' }));
    for (const key of ['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill', 'referral_drafts'] as const) {
      expect(html).toContain(SWITCH_WORDS[key].title.replace('&', '&amp;'));
    }
    expect(html).not.toMatch(/by default|Both switches|restores the previous behaviour/);
    expect(changeButtons(html)).toHaveLength(5);
  });

  it('a switch the database did not return shows Unknown with no change form; known switches keep theirs', () => {
    const html = render(states({ service_items_enabled: 'on', intake_prompt_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' }));
    expect(html.match(/data-state="unknown"/g)).toHaveLength(1);
    expect(html.match(/data-state="off"/g)).toHaveLength(3);
    expect(html.match(/data-state="on"/g)).toHaveLength(1);
    expect(html).toContain(SETTINGS_TEXT.unknownOne);
    expect(changeButtons(html)).toHaveLength(4);
    expect(html).not.toContain(`Change ${SWITCH_WORDS.visa_passport_tasks_enabled.title}`);
  });

  it('Batch 2: a database without the automatic-fill switch shows it as Unknown, never Off', () => {
    const html = render(states({ service_items_enabled: 'on', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'on', referral_drafts: 'on' }));
    expect(html.match(/data-state="unknown"/g)).toHaveLength(1);
    expect(html).not.toMatch(/data-state="off"/);
    expect(html).not.toContain(`Change ${SWITCH_WORDS.prefill_auto_fill.title}`);
  });

  it('Batch 3: the referral drafts row reads its own switch (never another switch, never Off when not reported)', () => {
    const unknown = render(states({ service_items_enabled: 'on', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'on', prefill_auto_fill: 'on' }));
    expect(unknown).not.toContain(`Change ${SWITCH_WORDS.referral_drafts.title}`);
    const off = render(states({ service_items_enabled: 'on', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'on', prefill_auto_fill: 'on', referral_drafts: 'off' }));
    expect(off.match(/data-state="on"/g)).toHaveLength(4);
    expect(off.match(/data-state="off"/g)).toHaveLength(1);
    expect(off).toContain(`Change ${SWITCH_WORDS.referral_drafts.title}`);
  });

  it('a settings read that failed or is not installed: every switch Unknown, no change form, never Off', () => {
    for (const load of ['error', 'not_installed'] as const) {
      const html = renderToStaticMarkup(createElement(FeaturesSettingsView, { model: featuresPageModel(load), actions, bitrixHref: null }));
      expect(html).not.toMatch(/data-state="off"/);
      expect(changeButtons(html)).toHaveLength(0);
    }
  });
});

describe('Settings · Bitrix connection switches', () => {
  it('a Bitrix switch whose state was not read offers no change form; a known one does', () => {
    const bitrix = (switches: Array<{ key: 'bitrix_id_proof_copy'; state: 'on' | 'off' | 'unknown' }>): SettingsSwitchStates => ({
      workflow: null,
      live: null,
      bitrix: {
        readable: true, canSwitch: true, canManageSync: true, connectionEnabled: true, pilotLegalEntityId: null, pilotBranchId: null, pilotBranchName: null,
        switches: switches.map((s) => ({ ...s, lastChange: null })),
        syncSettings: { categoryIds: null, stageIds: null, cutoffAt: null, leadIntakeMode: null, dealIntakeMode: null, autoSync: 'unknown', lastScopeChange: null, lastSaved: null },
      },
    });
    const html = (s: SettingsSwitchStates) => renderToStaticMarkup(createElement(SettingsSectionView, { id: 'b', title: 'Bitrix switches', section: bitrixPageModel(s).switches, actions }));
    const unknown = html(bitrix([{ key: 'bitrix_id_proof_copy', state: 'unknown' }]));
    expect(unknown).not.toContain(`Change ${SWITCH_WORDS.bitrix_id_proof_copy.title}`);
    expect(unknown).not.toMatch(/data-state="off"/);
    expect(html(bitrix([{ key: 'bitrix_id_proof_copy', state: 'off' }]))).toContain(`Change ${SWITCH_WORDS.bitrix_id_proof_copy.title}`);
  });
});

describe('Purchase approved budget', () => {
  it('zero means not set; any other amount is shown in rupees', () => {
    expect(budgetText('0')).toBe('Budget not set');
    expect(budgetText('4500000')).toBe('₹45,000.00');
    expect(budgetText('1')).toBe('₹0.01');
  });
});
