import { BITRIX_SWITCH_KEYS, WORKFLOW_SWITCH_KEYS, type LastChange, type SettingsSwitchStates, type VisaTaskPreview } from '@/modules/access/settings-state';
import { B12_SWITCH_TEXT, WORKFLOW_SETTING_LABEL, type B12SwitchKey, type WorkflowSettingKey } from '@/modules/fulfilment/contracts';
import { RECEIPT_MODE_LABEL, type ReceiptMode } from '@/modules/finance/contracts';
import { toLastChangeVM, type BitrixSwitchKey, type SettingKey, type SettingReviewVM, type SettingRowVM, type SwitchState } from './contracts';
import { READ_ONLY_WORDS, SETTINGS_TEXT, SWITCH_WORDS } from './text';

/*
 * Batch 4 (R6, M5, DA-253 to DA-258): Settings rows built from Atlas's
 * settings_switch_states() reply. Pure; no I/O. A switch is changeable only
 * when its state is known and the database says this person may switch it;
 * Unknown never offers a form and is never shown as Off. A section the person
 * may not read (null) gives no rows at all (not Unknown). Server side (pages
 * and actions); views receive the finished models.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${DATE_TIME.format(t)} IST`;
}

/** A section of the reply: the record, not readable for this person (null), unreadable, not installed or failed. */
export type SectionLoad<T> = T | null | 'unreadable' | 'not_installed' | 'error';

/** A row as the views receive it: the frozen SettingRowVM plus its finished text lines. */
export interface SettingRowModel extends SettingRowVM {
  /** DA-254 first line. */
  lastChangeLine: string;
  /** DA-254 second line ("Reason: “…”"), or null. */
  lastChangeReason: string | null;
  /** DA-255 line when the state is Unknown, else null. */
  unknownText: string | null;
}

/** A group of rows with the section-level line (DA-255) when the whole section is not readable. */
export interface SettingsSectionModel {
  rows: SettingRowModel[];
  /** null = the rows can be read (individual rows may still be Unknown). */
  sectionText: string | null;
  /** The database says this person may switch these (Super Admin at aal2 / of the config company). */
  canSwitch: boolean;
}

/** DA-254 wording, from the record (needs `to` for ": switched on/off"). undefined = could not be read. */
export function lastChangeText(record: LastChange | undefined): { line: string; reason: string | null } {
  if (record === undefined) return { line: SETTINGS_TEXT.lastUnknown, reason: null };
  if (record === null) return { line: SETTINGS_TEXT.lastNone, reason: null };
  const switched = record.to === null ? '' : `: switched ${record.to ? 'on' : 'off'}`;
  const line =
    record.byName === null
      ? fill(SETTINGS_TEXT.lastSystem, { at: when(record.at), switched })
      : fill(SETTINGS_TEXT.lastPerson, { at: when(record.at), name: record.byYou ? 'you' : record.byName, switched });
  return { line, reason: record.reason ? fill(SETTINGS_TEXT.lastReason, { reason: record.reason }) : null };
}

function sectionText(load: SectionLoad<unknown>): string | null {
  if (load === 'not_installed') return SETTINGS_TEXT.notInstalled;
  if (load === 'unreadable' || load === 'error') return SETTINGS_TEXT.unknownSection;
  if (typeof load === 'object' && load !== null && 'readable' in load && (load as { readable: boolean }).readable === false) return SETTINGS_TEXT.unknownSection;
  return null;
}

function detailOf(key: WorkflowSettingKey | BitrixSwitchKey): string {
  const words = SWITCH_WORDS[key];
  if (words.detail) return words.detail;
  if ((WORKFLOW_SWITCH_KEYS as readonly string[]).includes(key)) return WORKFLOW_SETTING_LABEL[key as WorkflowSettingKey].detail;
  if (key in B12_SWITCH_TEXT) return B12_SWITCH_TEXT[key as B12SwitchKey].detail;
  return '';
}

function review(key: WorkflowSettingKey | BitrixSwitchKey, extra: { on?: string[]; off?: string[] } = {}): SettingReviewVM {
  const words = SWITCH_WORDS[key];
  const scope = words.scope ? [SETTINGS_TEXT.scopeLine] : [];
  return {
    onText: [words.on, ...(extra.on ?? []), ...scope].join(' '),
    offText: [words.off, ...(extra.off ?? []), ...scope].join(' '),
    approvalLine: SETTINGS_TEXT.reviewApproval,
  };
}

function row(input: {
  key: SettingKey;
  title: string;
  detail: string;
  state: SwitchState;
  lastChange: LastChange | undefined;
  canSwitch: boolean;
  review: SettingReviewVM | null;
}): SettingRowModel {
  const known = input.state !== 'unknown';
  const text = lastChangeText(known ? input.lastChange : undefined);
  return {
    key: input.key,
    title: input.title,
    detail: input.detail,
    affects: 'Every branch',
    state: input.state,
    lastChange: toLastChangeVM(known ? input.lastChange : undefined),
    control: { kind: 'switch', canChange: known && input.canSwitch, blockedText: !known || input.canSwitch ? null : SETTINGS_TEXT.onlySuperAdmin },
    review: known && input.canSwitch ? input.review : null,
    lastChangeLine: text.line,
    lastChangeReason: text.reason,
    unknownText: known ? null : SETTINGS_TEXT.unknownOne,
  };
}

/** Features tab: the five workflow switches, always all five, in WORKFLOW_SWITCH_KEYS order (exhaustive; a missing key is Unknown). */
export function featureRows(load: SectionLoad<SettingsSwitchStates['workflow']>, ctx: { tripFactsRead: SwitchState } = { tripFactsRead: 'unknown' }): SettingsSectionModel {
  if (load === null) return { rows: [], sectionText: null, canSwitch: false };
  const section = typeof load === 'object' ? load : null;
  const readable = !!section && section.readable;
  const canSwitch = !!section && section.canSwitch;
  const rows = WORKFLOW_SWITCH_KEYS.map((key) => {
    const found = readable ? section!.switches.find((s) => s.key === key) : undefined;
    const fillExtra = key === 'prefill_auto_fill' && ctx.tripFactsRead !== 'on' ? [fill(SETTINGS_TEXT.fillNeedsRead, { state: ctx.tripFactsRead === 'off' ? 'off' : 'Unknown' })] : [];
    const r = review(key, { on: fillExtra });
    if (key === 'visa_passport_tasks_enabled') {
      // DA-258: counted when "Review change" is pressed (previewVisaTasksAction), never at page load.
      r.preview = { kind: 'visa_tasks', count: null, skipped: null, text: SETTINGS_TEXT.visaCounting };
      r.offText = SETTINGS_TEXT.visaOff;
    }
    return row({ key, title: SWITCH_WORDS[key].title, detail: detailOf(key), state: found?.state ?? 'unknown', lastChange: found ? found.lastChange : undefined, canSwitch, review: r });
  });
  return { rows, sectionText: sectionText(load), canSwitch };
}

/** Bitrix connection tab: the five Bitrix switches (won-only keeps its own card; its row is read-only here). */
export function bitrixRows(load: SectionLoad<SettingsSwitchStates['bitrix']>, ctx: { openStops?: number } = {}): SettingsSectionModel {
  if (load === null) return { rows: [], sectionText: null, canSwitch: false };
  const section = typeof load === 'object' ? load : null;
  const readable = !!section && section.readable;
  const canSwitch = !!section && section.canSwitch;
  const rows = BITRIX_SWITCH_KEYS.map((key) => {
    const found = readable ? section!.switches.find((s) => s.key === key) : undefined;
    const stops = key === 'bitrix_id_proof_copy' && ctx.openStops && ctx.openStops > 0 ? [fill(SETTINGS_TEXT.idProofOpenStops, { n: ctx.openStops })] : [];
    const built = row({ key, title: SWITCH_WORDS[key].title, detail: detailOf(key), state: found?.state ?? 'unknown', lastChange: found ? found.lastChange : undefined, canSwitch, review: review(key, { on: stops }) });
    if (key === 'won_only_intake') {
      // The rule needs entry stages, a dry run and a danger zone: it stays on its own card (WonOnlyCard).
      return { ...built, control: { kind: 'read_only' as const, text: 'Change it in “Bring in deals only when won” below.' }, review: null };
    }
    return built;
  });
  return { rows, sectionText: sectionText(load), canSwitch };
}

function readOnlyRow(key: SettingKey, title: string, state: SwitchState, lastChange: LastChange | undefined, words?: { on: string; off: string }, scope?: SettingRowVM['scope']): SettingRowModel {
  const known = state !== 'unknown';
  const text = lastChangeText(known ? lastChange : undefined);
  return {
    key,
    ...(scope ? { scope } : {}),
    title,
    detail: words ? (state === 'on' ? words.on : state === 'off' ? words.off : '') : '',
    affects: 'Every branch',
    state,
    lastChange: toLastChangeVM(known ? lastChange : undefined),
    control: { kind: 'read_only', text: SETTINGS_TEXT.readOnlyLine },
    review: null,
    lastChangeLine: text.line,
    lastChangeReason: text.reason,
    unknownText: known ? null : SETTINGS_TEXT.unknownOne,
  };
}

/** Features and System health read-only rows: real bookings and supplier confirmation (R7, DA-253). */
export function liveRows(load: SectionLoad<SettingsSwitchStates['live']>): SettingsSectionModel {
  if (load === null) return { rows: [], sectionText: null, canSwitch: false };
  const section = typeof load === 'object' ? load : null;
  return {
    rows: [
      readOnlyRow('real_booking', READ_ONLY_WORDS.real_booking.title, section?.realBooking.state ?? 'unknown', section?.realBooking.lastChange),
      readOnlyRow('supplier_confirmation', READ_ONLY_WORDS.supplier_confirmation.title, section?.supplierConfirmation.state ?? 'unknown', section?.supplierConfirmation.lastChange),
    ],
    sectionText: sectionText(load),
    canSwitch: false,
  };
}

/** Money rules: payment modes per company, read only (DA-264). */
export function financeModeRows(load: SectionLoad<SettingsSwitchStates['live']>): Array<{ legalEntityId: string; legalName: string; rows: SettingRowModel[] }> {
  if (load === null || typeof load !== 'object') return [];
  return load.financeModes.map((company) => ({
    legalEntityId: company.legalEntityId,
    legalName: company.legalName,
    rows: company.modes.map((m) =>
      readOnlyRow('finance_mode', RECEIPT_MODE_LABEL[m.key as ReceiptMode], m.state, m.lastChange, { on: READ_ONLY_WORDS.finance_mode.available, off: READ_ONLY_WORDS.finance_mode.notAvailable }, {
        legalEntityId: company.legalEntityId,
        legalName: company.legalName,
        mode: m.key as ReceiptMode,
      }),
    ),
  }));
}

/** The state of one Bitrix switch from a loaded section ('unknown' when not readable). */
export function bitrixSwitchState(load: SectionLoad<SettingsSwitchStates['bitrix']>, key: BitrixSwitchKey): SwitchState {
  if (load === null || typeof load !== 'object' || !load.readable) return 'unknown';
  return load.switches.find((s) => s.key === key)?.state ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Visa preview (DA-258)
// ---------------------------------------------------------------------------

export type VisaPreviewModel =
  | { state: 'counted'; wouldCreate: number; skipped: number; deals: number; lines: string[]; canConfirm: true }
  | { state: 'uncounted'; lines: string[]; canConfirm: false };

/** Count lines for the review step; an unreadable count disables the confirm button (lead ruling). */
export function visaPreviewModel(load: VisaTaskPreview | null | 'not_installed' | 'error'): VisaPreviewModel {
  if (load === null || typeof load !== 'object') return { state: 'uncounted', lines: [SETTINGS_TEXT.visaUncounted], canConfirm: false };
  const lines =
    load.wouldCreate > 0
      ? [fill(SETTINGS_TEXT.visaCount, { n: load.wouldCreate, tasks: load.wouldCreate === 1 ? 'task' : 'tasks', deals: load.deals, dealsWord: load.deals === 1 ? 'deal' : 'deals' })]
      : [SETTINGS_TEXT.visaCountZero];
  if (load.skipped > 0) lines.push(fill(SETTINGS_TEXT.visaSkipped, { skipped: load.skipped }));
  return { state: 'counted', wouldCreate: load.wouldCreate, skipped: load.skipped, deals: load.deals, lines, canConfirm: true };
}

/** Result line after switching Visa tasks on (DA-258): the actual count, and the review count only when it differs (lead ruling D5). */
export function visaResultText(created: number, reviewed: number | null): string {
  return reviewed !== null && reviewed !== created
    ? `Visa and passport tasks are on. ${fill(SETTINGS_TEXT.visaResultDiffers, { n: created, m: reviewed })}`
    : fill(SETTINGS_TEXT.visaResult, { n: created });
}

export { fill as fillSettingsText };
