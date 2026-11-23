import { parseTab } from '@/lib/parse-tab';
import { SETTINGS_CUSTOMER_MESSAGES_PATH } from '@/modules/settings/contracts';
import type { AdminCustomerMessages, MessageType } from './types';

/*
 * Settings › Customer messages sub-tabs (UX redesign R1, prototype S7) and
 * the WhatsApp block words without a language choice (owner decision D12:
 * every customer message goes in English). Pure; unit-tested in
 * tests/unit/r1-customer-messages-settings.test.ts.
 */

/** Switches is the address without ?tab= (the old address keeps opening it). */
export const MESSAGE_SETTINGS_TABS = ['switches', 'texts', 'pilot', 'setup'] as const;
export type MessageSettingsTab = (typeof MESSAGE_SETTINGS_TABS)[number];

export const MESSAGE_SETTINGS_TAB_LABEL: Record<MessageSettingsTab, string> = {
  switches: 'Switches',
  texts: 'Texts',
  pilot: 'Pilot list',
  setup: 'Set-up',
};

export function messageSettingsTabHref(tab: MessageSettingsTab): string {
  return tab === 'switches' ? SETTINGS_CUSTOMER_MESSAGES_PATH : `${SETTINGS_CUSTOMER_MESSAGES_PATH}?tab=${tab}`;
}

/** ?tab= of the Customer messages page. No value, an unknown value or a repeated value opens Switches. */
export function parseMessageSettingsTab(raw: unknown): MessageSettingsTab {
  return parseTab(raw, MESSAGE_SETTINGS_TABS, 'switches');
}

/** The English WhatsApp template of a message type, if the company has one. */
export function englishTemplate(type: MessageType, templates: AdminCustomerMessages['templates']) {
  return templates.find((t) => t.type === type && t.language === 'en');
}

/**
 * Why the WhatsApp switch of a type cannot be turned on now, or null.
 * Mirrors the database rule of contract 5.9 A7 (refusal template_not_approved),
 * which still asks for BOTH the English and the Hindi template to be approved.
 * The Hindi text is no longer shown (D12), so the words say plainly when only
 * that unused check is in the way, instead of offering a button the database
 * would refuse. Turning a switch off is never blocked.
 */
export function whatsappBlockText(type: MessageType, templates: AdminCustomerMessages['templates'], enabled: boolean): string | null {
  if (enabled) return null;
  const approved = (lang: 'en' | 'hi') => templates.some((t) => t.type === type && t.language === lang && t.status === 'approved');
  if (!approved('en')) return 'WhatsApp has not approved this text yet. Set its status on the Texts tab.';
  if (!approved('hi')) return 'Not yet: the CRM still checks an unused second text that WhatsApp has not approved. The CRM team must remove that check.';
  return null;
}

/** "4 of 18 on" etc. for the summary line of the Switches tab. */
export function switchesSummary(d: Pick<AdminCustomerMessages, 'switches' | 'pilotOnly' | 'pilot' | 'timer'>): string {
  const on = d.switches.filter((s) => s.enabled).length;
  const pilot = d.pilotOnly ? `pilot list on (${d.pilot.length} ${d.pilot.length === 1 ? 'Deal' : 'Deals'})` : 'pilot list off: every Deal';
  return `${on} of ${d.switches.length} on · ${pilot} · timer ${d.timer.enabled ? 'on' : 'off'}`;
}
