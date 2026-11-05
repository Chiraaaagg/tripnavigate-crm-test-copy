import 'server-only';
import { loadSettingsSwitchStates } from '@/modules/access/server/settings-state';
import type { SettingsSwitchStates } from '@/modules/access/settings-state';
import { BRANCHES, COMPANY_IDENTITY, type BranchCode } from '@/modules/documents/company-identity';
import type { StaffContext } from '@/modules/identity/server/session';
import { bitrixRows, bitrixSwitchState, featureRows, financeModeRows, liveRows, lastChangeText, type SectionLoad, type SettingRowModel, type SettingsSectionModel } from '../rows';
import { COMPANY_TEXT, SYNC_SCOPE_TEXT } from '../text';
import type { SettingsLoad, SwitchState } from '../contracts';

/*
 * Batch 4 Settings page reads (R6). One database read for every switch
 * state and "last changed" line (Atlas settings_switch_states()); its
 * sections the person may not read are null and give no rows. A read that
 * failed or is not installed shows Unknown (DA-255), never Off, and offers no
 * change form. Nothing here writes.
 */

type Staff = Pick<StaffContext, 'supabase'>;
type States = SettingsLoad<SettingsSwitchStates>;

export function loadSettingsStates(staff: Staff): Promise<States> {
  return loadSettingsSwitchStates(staff);
}

/** One section of the reply as the row builders take it. A refused read (null) reads as "not for this person". */
export function sectionOf<K extends keyof SettingsSwitchStates>(states: States, key: K): SectionLoad<Exclude<SettingsSwitchStates[K], 'unreadable'>> {
  if (states === null) return null;
  if (states === 'not_installed' || states === 'error') return states;
  const section = states[key];
  return section as SectionLoad<Exclude<SettingsSwitchStates[K], 'unreadable'>>;
}

export interface FeaturesPageModel {
  features: SettingsSectionModel;
  /** Read-only rows: real bookings, supplier confirmation. */
  live: SettingsSectionModel;
}

export function featuresPageModel(states: States): FeaturesPageModel {
  const tripFactsRead: SwitchState = bitrixSwitchState(sectionOf(states, 'bitrix'), 'bitrix_trip_facts_read');
  return { features: featureRows(sectionOf(states, 'workflow'), { tripFactsRead }), live: liveRows(sectionOf(states, 'live')) };
}

export interface SyncStateModel {
  /** null = the person may not manage the sync settings (no form). */
  canManageSync: boolean;
  current: { categoryIds: string[]; stageIds: string[]; cutoff: string | null; syncEnabled: boolean | null };
  autoSync: SwitchState;
  lastScopeChangeLine: string;
  lastScopeChangeReason: string | null;
  /** DA-259 "Last saved on … by …" + counts, or null. */
  lastSavedLines: string[] | null;
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const IST_DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

function istDay(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : IST_DAY.format(t);
}

export interface BitrixPageModel {
  switches: SettingsSectionModel;
  /** null = the Bitrix section is not readable for this person, unreadable, not installed or failed (the old form is never offered). */
  sync: SyncStateModel | null;
  /** DA-255 line for the sync section when sync is null and the section exists. */
  syncText: string | null;
}

export function bitrixPageModel(states: States, ctx: { openStops?: number } = {}): BitrixPageModel {
  const section = sectionOf(states, 'bitrix');
  const switches = bitrixRows(section, ctx);
  if (section === null) return { switches, sync: null, syncText: null };
  if (typeof section !== 'object' || !section.readable) {
    return { switches, sync: null, syncText: section === 'not_installed' ? SYNC_SCOPE_TEXT.refused.not_installed : switches.sectionText };
  }
  const s = section.syncSettings;
  const last = lastChangeText(s.lastScopeChange);
  const saved = s.lastSaved;
  const savedLines = saved
    ? [
        SYNC_SCOPE_TEXT.lastSaved.replace('{at}', `${IST_DATE_TIME.format(Date.parse(saved.at))} IST`).replace('{name}', saved.byYou ? 'you' : (saved.byName ?? 'a system update (no person recorded)')),
        ...(saved.hidden !== null && saved.broughtBack !== null
          ? [SYNC_SCOPE_TEXT.lastSavedCounts.replace('{hidden}', String(saved.hidden)).replace('{broughtBack}', String(saved.broughtBack))]
          : []),
      ]
    : null;
  return {
    switches,
    sync: {
      canManageSync: section.canManageSync,
      current: {
        categoryIds: (s.categoryIds ?? []).map(String),
        stageIds: s.stageIds ?? [],
        cutoff: istDay(s.cutoffAt),
        syncEnabled: s.autoSync === 'unknown' ? null : s.autoSync === 'on',
      },
      autoSync: s.autoSync,
      lastScopeChangeLine: last.line,
      lastScopeChangeReason: last.reason,
      lastSavedLines: savedLines,
    },
    syncText: null,
  };
}

export interface MoneyRulesModel {
  companies: Array<{ legalEntityId: string; legalName: string; rows: SettingRowModel[] }>;
  sectionText: string | null;
}

export function moneyRulesModel(states: States): MoneyRulesModel {
  const live = sectionOf(states, 'live');
  return { companies: financeModeRows(live), sectionText: live === null ? null : liveRows(live).sectionText };
}

// ---------------------------------------------------------------------------
// Company and branches (DA-261; DEC-50 code record, read only)
// ---------------------------------------------------------------------------

export interface CompanyBranchRow {
  name: string;
  state: string;
  gstin: string | null;
  /** The GSTIN cell text: the number, or "Not given yet…". */
  gstinText: string;
  pilot: 'yes' | 'no' | 'unknown';
  pilotText: string;
}

export interface CompanyPageModel {
  title: string;
  line: string;
  company: Array<{ label: string; value: string }>;
  branches: CompanyBranchRow[];
  /** Branches in the CRM that the approved record does not name (DA-261). */
  notApproved: string[];
  footer: string;
}

/** Company identity from the reviewed code record; branches and the Bitrix pilot from reads under the person's session. */
export async function loadCompanyPage(staff: Staff, states: States): Promise<CompanyPageModel> {
  const record = COMPANY_IDENTITY.HOLIDAY_CHACHA;
  const bitrix = sectionOf(states, 'bitrix');
  const pilotKnown = typeof bitrix === 'object' && bitrix !== null && bitrix.readable;
  const pilotId = pilotKnown ? bitrix.pilotBranchId : null;
  const { data } = await staff.supabase.from('branches').select('id, name, code').order('name');
  const dbBranches = ((data ?? []) as Array<{ id: string; name: string; code: string | null }>).filter((b) => typeof b.name === 'string');
  const idByCode = new Map(dbBranches.map((b) => [b.code, b.id]));
  const codes = Object.keys(BRANCHES) as BranchCode[];
  const branches: CompanyBranchRow[] = codes.map((code) => {
    const b = BRANCHES[code];
    const gstin = record.gstinByBranch[code];
    const id = idByCode.get(code);
    // Unknown when the Bitrix section or the branch id could not be read; never a guessed "No".
    const pilot: CompanyBranchRow['pilot'] = !pilotKnown || !id ? 'unknown' : pilotId === id ? 'yes' : 'no';
    return {
      name: b.name,
      state: b.state,
      gstin,
      gstinText: gstin ?? COMPANY_TEXT.gstinMissing,
      pilot,
      pilotText: pilot === 'yes' ? COMPANY_TEXT.pilotYes : pilot === 'no' ? COMPANY_TEXT.pilotNo : COMPANY_TEXT.pilotUnknown,
    };
  });
  const known = new Set<string>(codes);
  const notApproved = dbBranches.filter((b) => !b.code || !known.has(b.code)).map((b) => COMPANY_TEXT.notApproved.replaceAll('{branch}', b.name));
  return {
    title: COMPANY_TEXT.title,
    line: COMPANY_TEXT.line,
    company: [
      { label: COMPANY_TEXT.company, value: record.legalName },
      { label: COMPANY_TEXT.address, value: record.registeredAddress },
      { label: COMPANY_TEXT.pan, value: record.pan },
    ],
    branches,
    notApproved,
    footer: COMPANY_TEXT.footer,
  };
}
