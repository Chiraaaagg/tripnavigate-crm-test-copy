/*
 * Hotel and customer import: column mapping, row preparation and the
 * validation summary (Terra, voice-note batch, 24 October 2026). Pure
 * functions (no server imports).
 *
 * Owner rules (24 October 2026, work order item 5):
 *   - never guess: a column is mapped only when its name matches a known name
 *     exactly (case, spaces and punctuation ignored) or staff chose it; every
 *     other column is listed as "not imported" and its values are left out;
 *     a name two fields could claim is never picked;
 *   - never merge by name alone: the database matches rows to stored records
 *     only by their source reference (the ID column of the owner's sheet);
 *     rows that only share a name are flagged, never joined;
 *   - imported records are "Not checked"; nothing here marks a record checked;
 *   - the validation summary is read-only; applying is a separate, role-gated
 *     step on the server.
 *
 * The database (import_batch_validate) is the authority for every row rule;
 * this file only maps columns, tidies values the way staff type them (spaces,
 * "+91" phones, state names, yes/no) and refuses spreadsheet formulas. Cell
 * values are never logged.
 */

import type { ImportStatus, ImportSummaryView } from '@/views/booking-form/vn-types';
import { normalisePhone } from '@/modules/fulfilment/booking-form-model';
import { looksLikeFormula, safeCellText, type CsvTable } from './csv';

export type { ImportStatus, ImportSummaryView };
export type ImportKind = 'hotel' | 'customer';
export const IMPORT_KINDS = ['hotel', 'customer'] as const satisfies readonly ImportKind[];
export const IMPORT_KIND_LABEL: Record<ImportKind, string> = { hotel: 'Hotels', customer: 'Customers' };

export interface ImportFieldDef {
  /** The database row key (import_batch_stage p_rows). */
  key: string;
  label: string;
  required: boolean;
  /** Column names that map to this field without asking (compared after normaliseHeader). */
  aliases: readonly string[];
}

/** Hotel catalogue row keys (Atlas shapes v1 §h). */
export const HOTEL_IMPORT_FIELDS = [
  { key: 'sourceRef', label: 'Hotel ID (from your list)', required: false, aliases: ['hotel id', 'id', 'hotel code', 'code', 'source id', 'ref', 'reference'] },
  { key: 'name', label: 'Hotel name', required: true, aliases: ['hotel name', 'hotel', 'name', 'property', 'property name'] },
  { key: 'city', label: 'City', required: true, aliases: ['city', 'town'] },
  { key: 'area', label: 'Area', required: false, aliases: ['area', 'locality', 'location'] },
  { key: 'address', label: 'Address', required: false, aliases: ['address', 'hotel address', 'full address'] },
  { key: 'starCategory', label: 'Star category', required: false, aliases: ['star', 'stars', 'star rating', 'star category', 'rating', 'category'] },
  { key: 'status', label: 'Status (active or inactive)', required: false, aliases: ['status', 'active'] },
] as const satisfies readonly ImportFieldDef[];

/** Customer (bill-to party) row keys (Atlas shapes v1 §h). India only, like Bill To. */
export const CUSTOMER_IMPORT_FIELDS = [
  { key: 'sourceRef', label: 'Customer ID (from your list)', required: false, aliases: ['customer id', 'client id', 'id', 'code', 'customer code', 'client code', 'source id', 'ref', 'reference'] },
  { key: 'partyType', label: 'Type (personal or business)', required: true, aliases: ['type', 'customer type', 'client type', 'party type', 'personal or business'] },
  { key: 'name', label: 'Name or company name', required: true, aliases: ['name', 'customer name', 'client name', 'company', 'company name', 'customer', 'client', 'party name'] },
  { key: 'contactPerson', label: 'Contact person (business)', required: false, aliases: ['contact person', 'contact name', 'contact'] },
  { key: 'phone', label: 'Phone', required: false, aliases: ['phone', 'mobile', 'mobile number', 'phone number', 'contact number', 'contact no'] },
  { key: 'email', label: 'Email', required: false, aliases: ['email', 'email id', 'e mail', 'mail'] },
  { key: 'addressLine1', label: 'Address', required: false, aliases: ['address', 'address line 1', 'address 1', 'billing address'] },
  { key: 'addressLine2', label: 'Address line 2', required: false, aliases: ['address line 2', 'address 2'] },
  { key: 'city', label: 'City', required: false, aliases: ['city', 'town'] },
  { key: 'stateCode', label: 'State (name or GST code)', required: false, aliases: ['state', 'state name', 'state code', 'gst state'] },
  { key: 'postalCode', label: 'PIN code', required: false, aliases: ['pin', 'pin code', 'pincode', 'postal code', 'zip', 'zip code'] },
  { key: 'gstStatus', label: 'GST registered (yes or no)', required: false, aliases: ['gst registered', 'gst status', 'registered', 'gst registration'] },
  { key: 'gstin', label: 'GSTIN', required: false, aliases: ['gstin', 'gst', 'gst no', 'gst number', 'gstin number'] },
  { key: 'gstReason', label: 'Reason for no GSTIN', required: false, aliases: ['gst reason', 'reason', 'no gst reason', 'unregistered reason'] },
] as const satisfies readonly ImportFieldDef[];

export function importFields(kind: ImportKind): readonly ImportFieldDef[] {
  return kind === 'hotel' ? HOTEL_IMPORT_FIELDS : CUSTOMER_IMPORT_FIELDS;
}

/** "Hotel  Name", "hotel_name", "HOTEL-NAME" → "hotel name". */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Staff's choice for one column: a field key, or 'ignore' (deliberately not imported). */
export const IGNORE_COLUMN = 'ignore';

export interface MappingResult {
  /** Field key → 0-based column index. */
  columns: Record<string, number>;
  /** Header → field key or 'ignore' (absent = unknown, not imported). */
  byHeader: Record<string, string>;
  /** Columns neither matched nor chosen: listed as not imported, never guessed. */
  unknownHeaders: string[];
  /** Columns staff chose to leave out. */
  ignoredHeaders: string[];
  /** Required fields with no column. */
  missingRequired: string[];
  /** Fields claimed by two or more columns (which one is meant?). */
  duplicateTargets: string[];
  /** Choices naming a field that does not exist for this kind, or a header that is not in the file. */
  invalidChoices: string[];
  /** True when the mapping can be used: nothing required missing, no conflicts (unknown columns are left out). */
  complete: boolean;
}

/**
 * The column mapping for one file. `chosen` (staff's explicit choices, keyed
 * by the header exactly as in the file) wins over the known names; a column
 * without a choice maps only when its normalised name is a known name of
 * exactly one field. Nothing else is guessed.
 */
export function resolveMapping(kind: ImportKind, headers: readonly string[], chosen: Readonly<Record<string, string>> = {}): MappingResult {
  const fields = importFields(kind);
  const fieldKeys = new Set(fields.map((f) => f.key));
  const aliasOwner = new Map<string, string[]>();
  for (const f of fields) {
    for (const a of [f.key, f.label, ...f.aliases]) {
      const k = normaliseHeader(a);
      aliasOwner.set(k, [...new Set([...(aliasOwner.get(k) ?? []), f.key])]);
    }
  }
  const headerSet = new Set(headers);
  const invalidChoices: string[] = [];
  for (const [header, choice] of Object.entries(chosen)) {
    if (!headerSet.has(header) || (choice !== IGNORE_COLUMN && !fieldKeys.has(choice))) invalidChoices.push(header);
  }

  const byHeader: Record<string, string> = {};
  const unknownHeaders: string[] = [];
  const ignoredHeaders: string[] = [];
  const targets = new Map<string, number[]>();
  headers.forEach((header, index) => {
    const choice = Object.prototype.hasOwnProperty.call(chosen, header) && !invalidChoices.includes(header) ? chosen[header]! : null;
    if (choice === IGNORE_COLUMN) {
      byHeader[header] = IGNORE_COLUMN;
      ignoredHeaders.push(header);
      return;
    }
    let target: string | null = choice;
    if (!target) {
      const owners = aliasOwner.get(normaliseHeader(header)) ?? [];
      if (owners.length === 1) target = owners[0]!;
    }
    if (!target) {
      unknownHeaders.push(header);
      return;
    }
    byHeader[header] = target;
    targets.set(target, [...(targets.get(target) ?? []), index]);
  });

  const columns: Record<string, number> = {};
  const duplicateTargets: string[] = [];
  for (const [key, idx] of targets) {
    if (idx.length > 1) duplicateTargets.push(key);
    else columns[key] = idx[0]!;
  }
  const missingRequired = fields.filter((f) => f.required && columns[f.key] === undefined && !duplicateTargets.includes(f.key)).map((f) => f.key);
  return {
    columns,
    byHeader,
    unknownHeaders,
    ignoredHeaders,
    missingRequired,
    duplicateTargets,
    invalidChoices,
    complete: missingRequired.length === 0 && duplicateTargets.length === 0 && invalidChoices.length === 0,
  };
}

/** Labels of field keys for staff (unknown keys shown as they are). */
export function fieldLabel(kind: ImportKind, key: string): string {
  return importFields(kind).find((f) => f.key === key)?.label ?? key;
}

/** Plain words for a mapping that cannot be used (empty when it can). */
export function mappingBlockers(kind: ImportKind, m: MappingResult): string[] {
  const out: string[] = [];
  if (m.missingRequired.length > 0) out.push(`Add a column for: ${m.missingRequired.map((k) => fieldLabel(kind, k)).join(', ')}.`);
  if (m.duplicateTargets.length > 0) out.push(`Two columns are used for: ${m.duplicateTargets.map((k) => fieldLabel(kind, k)).join(', ')}. Rename or delete one of them.`);
  if (m.invalidChoices.length > 0) out.push('Some column choices do not match this file. Choose the columns again.');
  return out;
}

// ---------------------------------------------------------------------------
// Row preparation (what is sent to import_batch_stage)
// ---------------------------------------------------------------------------

type StateList = ReadonlyArray<{ code: string; name: string }>;

export interface PreparedRows {
  kind: ImportKind;
  /** One object per data row, in file order (row number = index + 1); mapped keys only; '' → null. */
  rows: Array<Record<string, string | null>>;
  /** Display names by row number (formula-safe), for the proposed-changes list. */
  names: string[];
  /** Data rows (1-based) with a value that reads as a spreadsheet formula; the file is refused while any exist. */
  formulaRows: number[];
}

const tidy = (v: string): string => v.replace(/\s+/g, ' ').trim();

function yesNo(v: string): string {
  const t = v.toLowerCase();
  if (['yes', 'y', 'registered', 'true', '1'].includes(t)) return 'registered';
  if (['no', 'n', 'unregistered', 'not registered', 'false', '0'].includes(t)) return 'unregistered';
  return v; // the database names it invalid
}

function partyType(v: string): string {
  const t = v.toLowerCase();
  if (t === 'personal' || t === 'individual') return 'personal';
  if (t === 'business' || t === 'company' || t === 'corporate') return 'business';
  return v;
}

function stateCode(v: string, states: StateList): string {
  const padded = /^\d$/.test(v) ? `0${v}` : v;
  if (/^\d{2}$/.test(padded)) return padded;
  return states.find((s) => s.name.toLowerCase() === v.toLowerCase())?.code ?? v;
}

/**
 * Maps every data row to the database keys and tidies values the way staff
 * type them; it never drops or invents a value (an unreadable value is sent
 * as typed and the database names it).
 */
export function prepareRows(kind: ImportKind, table: CsvTable, mapping: MappingResult, states: StateList): PreparedRows {
  const fields = importFields(kind);
  const formulaRows: number[] = [];
  const names: string[] = [];
  const rows = table.rows.map((cells, i) => {
    const out: Record<string, string | null> = {};
    let formula = false;
    for (const f of fields) {
      const col = mapping.columns[f.key];
      if (col === undefined) continue;
      const v = tidy(cells[col] ?? '');
      if (v === '') {
        out[f.key] = null;
        continue;
      }
      if (f.key !== 'phone' && looksLikeFormula(v)) formula = true;
      out[f.key] = v;
    }
    if (out.phone) {
      if (looksLikeFormula(out.phone) && normalisePhone(out.phone) === undefined) formula = true;
      const p = normalisePhone(out.phone);
      if (typeof p === 'string') out.phone = p;
    }
    if (out.email) out.email = out.email.toLowerCase();
    if (kind === 'customer') {
      if (out.partyType) out.partyType = partyType(out.partyType);
      if (out.stateCode) out.stateCode = stateCode(out.stateCode, states);
      if (out.postalCode) out.postalCode = out.postalCode.replace(/\s/g, '');
      if (out.gstin) out.gstin = out.gstin.toUpperCase().replace(/\s/g, '');
      if (out.gstStatus) out.gstStatus = yesNo(out.gstStatus);
      if (out.partyType === 'business' && !out.gstStatus && out.gstin) out.gstStatus = 'registered';
    } else {
      if (out.starCategory) out.starCategory = /^[1-7](\.0)?(\s*star)?$/i.test(out.starCategory) ? out.starCategory[0]! : out.starCategory;
      if (out.status) out.status = out.status.toLowerCase();
    }
    if (formula) formulaRows.push(i + 1);
    names.push(safeCellText(out.name ?? ''));
    return out;
  });
  return { kind, rows, names, formulaRows };
}

export function formulaRowsText(rows: readonly number[]): string {
  const shown = rows.slice(0, 10).join(', ');
  return `Some cells start like a spreadsheet formula (=, + or @), in ${rows.length === 1 ? 'row' : 'rows'} ${shown}${rows.length > 10 ? ' and more' : ''}. Remove that sign in Excel, save as CSV again and choose the file again. Nothing was imported.`;
}

// ---------------------------------------------------------------------------
// Validation summary (database dry run → what staff see)
// ---------------------------------------------------------------------------

/** import_batch_validate reason codes (Atlas shapes v1 §h) in plain words. */
export const IMPORT_REASON_TEXT: Record<string, string> = {
  name_missing: 'Name is empty.',
  name_too_long: 'Name is longer than 200 characters.',
  city_missing: 'City is empty.',
  city_too_long: 'City is longer than 120 characters.',
  area_too_long: 'Area is longer than 120 characters.',
  address_too_long: 'Address is too long.',
  star_category_invalid: 'Star category must be a whole number from 1 to 7.',
  status_invalid: 'Status must be active or inactive.',
  party_type_invalid: 'Type must be personal or business.',
  contact_person_not_allowed: 'Contact person is for business customers only.',
  phone_invalid: 'Phone is not a 10-digit Indian mobile or a +country number.',
  email_invalid: 'Email is not a valid address.',
  state_code_invalid: 'State is not an Indian state name or GST state code.',
  postal_code_invalid: 'PIN code must be six digits and not start with 0.',
  gst_status_invalid: 'GST registered must be yes or no.',
  gst_not_allowed: 'GST details are for business customers only.',
  gstin_invalid: 'GSTIN shape is wrong.',
  gstin_state_mismatch: 'GSTIN first two digits do not match the state.',
  gstin_missing: 'Business is GST registered but has no GSTIN.',
  gst_reason_invalid: 'Reason for no GSTIN must be 10 to 500 characters.',
  gst_reason_missing: 'Business is not GST registered: give the reason.',
  source_ref_invalid: 'ID is longer than 80 characters.',
  unknown_column: 'The row has a column the list cannot store.',
  not_text: 'A value is not plain text.',
  duplicate_in_file: 'This ID appears more than once in the file.',
};

export const DUPLICATE_KIND_TEXT = {
  in_file: 'This ID appears more than once in the file. These rows are not imported.',
  same_name: 'Same name as a stored record. Kept separate; nothing is merged by name.',
} as const;

/** import_batch_validate answer (Atlas shapes v1 §h), as Atlas's wrapper returns it. */
export interface ImportValidation {
  batchId: string;
  kind: ImportKind;
  status: string;
  rows: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  possibleDuplicates: number;
  proposed: { create: number; update: number; unchanged: number; skippedChecked: number };
  invalidRows: Array<{ rowNo: number; reasons: string[] }>;
  duplicateRows: Array<{ rowNo: number; sourceRef: string | null; kind: 'in_file' | 'same_name' }>;
  rowVersion: number;
  /** Atlas v4: rows the database read with an assumption (still imported), and which. */
  assumedRows?: number;
  /** Echo-A L6: update rows where a blank cell clears a stored value (notes `will_clear:<key>`). */
  clearRows?: number;
  rowNotes?: Array<{ rowNo: number; notes: string[] }>;
  /** Echo-A L3: the fingerprint of what this dry run proposes; Apply posts it back. */
  proposalHash?: string | null;
  /** Echo-A M1: the branch the customers go to (null with entityWide = every branch). */
  branchName?: string | null;
  entityWide?: boolean;
}

/** Assumption notes of import_batch_validate (Atlas v4) in plain words. */
export const IMPORT_NOTE_TEXT: Record<string, string> = {
  gst_status_assumed_registered: 'GST registered was empty; read as registered because a GSTIN is given.',
  state_code_padded: 'State code had one digit; read with a leading 0.',
};

/** The summary plus the rows read with an assumption (the screen may list them; they still import). */
export type ImportSummaryWithNotes = ImportSummaryView & { assumedRows: number; clearingRows: number; rowNotes: Array<{ rowNo: number; text: string }> };

/** One assumption or clearing note in plain words ('will_clear:area' → "Will clear the stored Area."). */
export function importNoteText(kind: ImportKind, note: string): string | null {
  const clear = /^will_clear:([A-Za-z0-9]{1,40})$/.exec(note);
  if (clear) return `A blank cell will clear the stored ${fieldLabel(kind, clear[1]!)}.`;
  return IMPORT_NOTE_TEXT[note] ?? null;
}

/** Row outcomes from import_batch_get (create/update only are listed as proposed). */
export interface ImportRowOutcome {
  rowNo: number;
  outcome: string;
}

/** Rows listed per group (the counts always cover the whole file). */
export const SUMMARY_LIST_LIMIT = 50;

/**
 * The summary staff see before applying (Luna's ImportSummaryView). Columns
 * not matched or chosen are shown as not imported (field null). Apply is
 * offered only for a validated batch with something to create or update and
 * a usable mapping; the server re-checks everything and gates by role.
 */
export function importSummaryView(input: {
  kind: ImportKind;
  fileName: string;
  headers: readonly string[];
  mapping: MappingResult;
  validation: ImportValidation;
  /** Display names by row number (prepareRows().names); absent after a reload (names then shown as "Row n"). */
  names?: readonly string[];
  /** Row outcomes for the proposed list (first create/update rows); absent = no list, counts only. */
  outcomes?: readonly ImportRowOutcome[];
  status?: ImportStatus;
}): ImportSummaryWithNotes {
  const { kind, mapping, validation: v } = input;
  const status: ImportStatus = input.status ?? (v.status === 'applied' ? 'applied' : v.status === 'validated' ? 'validated' : 'expired');
  const nameOf = (rowNo: number) => input.names?.[rowNo - 1] || `Row ${rowNo}`;
  const proposed = (input.outcomes ?? [])
    .filter((o) => o.outcome === 'create' || o.outcome === 'update')
    .slice(0, SUMMARY_LIST_LIMIT)
    .map((o) => ({ rowNo: o.rowNo, action: o.outcome as 'create' | 'update', name: nameOf(o.rowNo), changes: [] as string[] }));
  const blockers = mappingBlockers(kind, mapping);
  if (status === 'applied') blockers.push('This file was already imported.');
  else if (status === 'expired') blockers.push('This check is no longer current. Check the file again.');
  else if (blockers.length === 0 && v.proposed.create + v.proposed.update === 0) blockers.push('Nothing to import: every row is invalid, unchanged or already checked.');
  return {
    batchId: v.batchId,
    kind,
    fileName: safeCellText(input.fileName),
    status,
    counts: {
      rows: v.rows,
      valid: v.valid,
      invalid: v.invalid,
      duplicates: v.duplicatesInFile + v.possibleDuplicates,
      creates: v.proposed.create,
      updates: v.proposed.update,
      unchanged: v.proposed.unchanged,
      skippedVerified: v.proposed.skippedChecked,
    },
    mapping: input.headers.map((h) => {
      const t = mapping.byHeader[h];
      return { column: safeCellText(h), field: t && t !== IGNORE_COLUMN ? fieldLabel(kind, t) : null };
    }),
    invalidRows: v.invalidRows.slice(0, SUMMARY_LIST_LIMIT).map((r) => ({ rowNo: r.rowNo, reasons: [...new Set(r.reasons.map((c) => IMPORT_REASON_TEXT[c] ?? 'This row cannot be imported.'))] })),
    duplicateRows: v.duplicateRows.slice(0, SUMMARY_LIST_LIMIT).map((r) => ({ rowNo: r.rowNo, text: DUPLICATE_KIND_TEXT[r.kind] })),
    proposed,
    applyBlockedReason: blockers.length > 0 ? blockers.join(' ') : null,
    assumedRows: v.assumedRows ?? 0,
    clearingRows: v.clearRows ?? 0,
    rowVersion: v.rowVersion,
    proposalHash: v.proposalHash ?? null,
    ...(kind === 'customer' ? { branchName: v.entityWide ? null : (v.branchName ?? null) } : {}),
    rowNotes: (v.rowNotes ?? []).slice(0, SUMMARY_LIST_LIMIT).flatMap((r) => {
      const words = [...new Set(r.notes.map((n) => importNoteText(kind, n)).filter((n): n is string => Boolean(n)))];
      return words.length > 0 ? [{ rowNo: r.rowNo, text: words.join(' ') }] : [];
    }),
  };
}
