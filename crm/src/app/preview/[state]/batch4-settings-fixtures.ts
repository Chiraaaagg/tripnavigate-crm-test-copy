import type { BitrixSection, LastChange, LiveSection, SettingsSwitchStates, WorkflowSection } from '@/modules/access/settings-state';
import type { WorkflowSettingKey } from '@/modules/fulfilment/contracts';
import type { BitrixPipeline } from '@/modules/integration/bitrix/directory';
import type { CompanyPageModel } from '@/modules/settings/server/queries';
import { COMPANY_TEXT } from '@/modules/settings/text';

/*
 * Batch 4 Settings preview fixtures: synthetic settings_switch_states()
 * replies (Atlas shapes) and page models. No real person, deal or company
 * value beyond the reviewed company record already in the code.
 */

export function lastChange(at: string, byName: string | null, to: boolean | null, reason: string | null, byYou = false): NonNullable<LastChange> {
  return { at, byName, byYou, via: byName ? 'command' : 'direct_sql', command: byName ? 'admin_set_workflow_setting' : null, from: to === null ? null : !to, to, fields: [], reason };
}

const OWNER_CHANGE = lastChange('2026-10-20T09:15:00.000Z', 'Synthetic Owner Jodhpur', true, 'Owner APPROVE in chat on 20 Oct (synthetic).');

export function workflowSection(
  states: Partial<Record<WorkflowSettingKey, 'on' | 'off' | 'unknown'>>,
  opts: { canSwitch?: boolean; readable?: boolean } = {},
): WorkflowSection {
  const keys: WorkflowSettingKey[] = ['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill', 'referral_drafts'];
  return {
    readable: opts.readable ?? true,
    canSwitch: opts.canSwitch ?? true,
    switches: keys
      .filter((k) => states[k] !== undefined)
      .map((key, i) => ({
        key,
        state: states[key]!,
        lastChange: i === 0 ? OWNER_CHANGE : i === 1 ? lastChange('2026-10-05T06:00:00.000Z', null, false, null) : i === 2 ? null : lastChange('2026-10-18T12:40:00.000Z', 'Synthetic Admin Jodhpur', false, null, true),
      })),
  };
}

export const FEATURES_ALL_KNOWN = { service_items_enabled: 'on', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' } as const;

export const liveSection: LiveSection = {
  realBooking: { state: 'off', lastChange: null },
  supplierConfirmation: { state: 'on', lastChange: lastChange('2026-10-08T10:00:00.000Z', null, true, null) },
  financeModes: [
    {
      legalEntityId: 'e0000000-0000-4000-8000-000000000001',
      legalName: 'Holiday Chacha Pvt LTD',
      modes: [
        { key: 'bank_transfer', state: 'on', lastChange: lastChange('2026-10-09T08:00:00.000Z', null, true, null) },
        { key: 'upi', state: 'on', lastChange: lastChange('2026-10-09T08:00:00.000Z', null, true, null) },
        { key: 'cash', state: 'off', lastChange: null },
        { key: 'cheque', state: 'unknown', lastChange: null },
      ],
    },
  ],
};

export const PILOT_BRANCH_ID = 'b0000000-0000-4000-8000-000000000001';

export function bitrixSection(opts: { canSwitch?: boolean; canManageSync?: boolean; readable?: boolean; copy?: 'on' | 'off' | 'unknown'; autoSync?: 'on' | 'off' | 'unknown' } = {}): BitrixSection {
  return {
    readable: opts.readable ?? true,
    canSwitch: opts.canSwitch ?? true,
    canManageSync: opts.canManageSync ?? true,
    connectionEnabled: true,
    pilotLegalEntityId: 'e0000000-0000-4000-8000-000000000001',
    pilotBranchId: PILOT_BRANCH_ID,
    pilotBranchName: 'Jodhpur',
    switches: [
      { key: 'bitrix_trip_facts_read', state: 'on', lastChange: lastChange('2026-10-14T07:30:00.000Z', 'Synthetic Owner Jodhpur', true, 'Owner APPROVE for reading trip facts (synthetic).') },
      { key: 'lead_intake_unowned', state: 'off', lastChange: null },
      { key: 'bitrix_id_proof_copy', state: opts.copy ?? 'off', lastChange: lastChange('2026-10-13T11:00:00.000Z', null, false, null) },
      { key: 'bitrix_name_read', state: 'on', lastChange: lastChange('2026-10-20T08:00:00.000Z', 'Synthetic Owner Jodhpur', true, null) },
      { key: 'won_only_intake', state: 'off', lastChange: null },
    ],
    syncSettings: {
      categoryIds: [0, 7],
      stageIds: ['NEW', 'WON', 'C7:NEW'],
      cutoffAt: '2026-09-01T00:00:00+05:30',
      leadIntakeMode: 'scope',
      dealIntakeMode: 'scope',
      autoSync: opts.autoSync ?? 'on',
      lastScopeChange: lastChange('2026-10-02T05:30:00.000Z', 'Synthetic Integration Admin', null, 'Owner APPROVE: start date moved to 1 Sep (synthetic).'),
      lastSaved: { at: '2026-10-02T05:30:00.000Z', byName: 'Synthetic Integration Admin', byYou: false, reason: 'Owner APPROVE: start date moved to 1 Sep (synthetic).', autoSync: true, hidden: 4, broughtBack: 0 },
    },
  };
}

export function switchStates(over: Partial<SettingsSwitchStates> = {}): SettingsSwitchStates {
  return { workflow: workflowSection(FEATURES_ALL_KNOWN), bitrix: bitrixSection(), live: liveSection, ...over };
}

export const SYNTHETIC_PIPELINES: BitrixPipeline[] = [
  {
    id: '0',
    name: 'Synthetic general pipeline',
    stages: [
      { id: 'NEW', name: 'New enquiry', kind: 'open' },
      { id: 'PREPARATION', name: 'Quote sent', kind: 'open' },
      { id: 'WON', name: 'Won - Payment Received', kind: 'won' },
      { id: 'LOSE', name: 'Lost', kind: 'lost' },
    ],
  },
  {
    id: '7',
    name: 'Synthetic corporate pipeline',
    stages: [
      { id: 'C7:NEW', name: 'New request', kind: 'open' },
      { id: 'C7:WON', name: 'Won', kind: 'won' },
    ],
  },
] as BitrixPipeline[];

export function companyModel(pilot: 'yes' | 'unknown' = 'yes'): CompanyPageModel {
  return {
    title: COMPANY_TEXT.title,
    line: COMPANY_TEXT.line,
    company: [
      { label: COMPANY_TEXT.company, value: 'Holiday Chacha Pvt LTD' },
      { label: COMPANY_TEXT.address, value: 'Synthetic registered address, Jodhpur, Rajasthan' },
      { label: COMPANY_TEXT.pan, value: 'AAAAA0000A' },
    ],
    branches: [
      { name: 'Ahmedabad', state: 'Gujarat', gstin: null, gstinText: COMPANY_TEXT.gstinMissing, pilot: pilot === 'yes' ? 'no' : 'unknown', pilotText: pilot === 'yes' ? COMPANY_TEXT.pilotNo : COMPANY_TEXT.pilotUnknown },
      { name: 'Delhi', state: 'Delhi', gstin: null, gstinText: COMPANY_TEXT.gstinMissing, pilot: pilot === 'yes' ? 'no' : 'unknown', pilotText: pilot === 'yes' ? COMPANY_TEXT.pilotNo : COMPANY_TEXT.pilotUnknown },
      { name: 'Jodhpur', state: 'Rajasthan', gstin: '08AAAAA0000A1Z5', gstinText: '08AAAAA0000A1Z5', pilot: pilot === 'yes' ? 'yes' : 'unknown', pilotText: pilot === 'yes' ? COMPANY_TEXT.pilotYes : COMPANY_TEXT.pilotUnknown },
    ],
    notApproved: pilot === 'yes' ? [] : [COMPANY_TEXT.notApproved.replaceAll('{branch}', 'Synthetic Udaipur')],
    footer: COMPANY_TEXT.footer,
  };
}
