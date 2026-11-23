import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  AccountsDeskCommandError,
  accountsDailyCheck,
  accountsDues,
  accountsFilterOptions,
  accountsRecords,
  accountsRecordsTotals,
  accountsSupplierPayables,
  accountsTallyExports,
  adminAccountsSettings,
  dealDues,
  supplierDocumentLinkTargets,
  tallyMappingHistory,
  tallyMappingList,
} from '../commands';
import type {
  AdminAccountsSettingsView,
  DailyCheck,
  DealDues,
  DuesFilter,
  DuesPage,
  FilterOptionsView,
  LinkTargetsView,
  RecordsFilter,
  RecordsPage,
  RecordsTotals,
  SupplierPayablesView,
  TallyExportsView,
  TallyMappingHistoryView,
  TallyMappingView,
} from '../contracts';
import {
  toAdminAccountsSettings,
  toDailyCheck,
  toDealDues,
  toDuesPage,
  toRecordsPage,
  toRecordsTotals,
  toSupplierPayables,
  toTallyExports,
  toTallyMapping,
  toTallyMappingHistory,
} from '../dto';

/**
 * Accounts desk reads under the staff member's own session. Every read
 * returns null when the database says this person may not read it (the page
 * shows "not available"); a refused filter (invalid_input) is reported as
 * { invalid: field } for the list reads so the page can keep the typed
 * filter and point at it. An unexplained failure throws (never a fabricated
 * empty state).
 */

type Staff = Pick<StaffContext, 'supabase'>;

export type ListResult<T> = { ok: true; data: T | null } | { ok: false; invalid: string | null };

function isRefusal(error: unknown): boolean {
  return (
    error instanceof AccountsDeskCommandError &&
    (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'not_configured' || error.code === 'environment_unset')
  );
}

function invalidField(error: unknown): string | null | undefined {
  if (error instanceof AccountsDeskCommandError && error.code === 'invalid_input') return error.hint ?? null;
  return undefined;
}

export async function loadRecords(staff: Staff, filter: RecordsFilter, after: string | null, limit = 50): Promise<ListResult<RecordsPage>> {
  try {
    const page = await accountsRecords(asRpcClient(staff.supabase), filter, after, limit);
    return { ok: true, data: page ? toRecordsPage(page) : null };
  } catch (error) {
    const field = invalidField(error);
    if (field !== undefined) return { ok: false, invalid: field };
    if (isRefusal(error)) return { ok: true, data: null };
    throw new Error('Could not load documents and money. Please retry.');
  }
}

export async function loadRecordsTotals(staff: Staff, filter: RecordsFilter): Promise<ListResult<RecordsTotals>> {
  try {
    const totals = await accountsRecordsTotals(asRpcClient(staff.supabase), filter);
    return { ok: true, data: totals ? toRecordsTotals(totals) : null };
  } catch (error) {
    const field = invalidField(error);
    if (field !== undefined) return { ok: false, invalid: field };
    if (isRefusal(error)) return { ok: true, data: null };
    throw new Error('Could not work out the totals. Please retry.');
  }
}

export async function loadDailyCheck(staff: Staff): Promise<DailyCheck | null> {
  try {
    const check = await accountsDailyCheck(asRpcClient(staff.supabase));
    return check ? toDailyCheck(check) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the daily check. Please retry.');
  }
}

export async function loadDues(staff: Staff, filter: DuesFilter, after: string | null, limit = 50): Promise<ListResult<DuesPage>> {
  try {
    const page = await accountsDues(asRpcClient(staff.supabase), filter, after, limit);
    return { ok: true, data: page ? toDuesPage(page) : null };
  } catch (error) {
    const field = invalidField(error);
    if (field !== undefined) return { ok: false, invalid: field };
    if (isRefusal(error)) return { ok: true, data: null };
    throw new Error('Could not load dues. Please retry.');
  }
}

export async function loadDealDues(staff: Staff, dealId: string): Promise<DealDues | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    const dues = await dealDues(asRpcClient(staff.supabase), id.data);
    return dues ? toDealDues(dues) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the dues for this Deal. Please retry.');
  }
}

export async function loadSupplierPayables(staff: Staff, dealId: string): Promise<SupplierPayablesView | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    const view = await accountsSupplierPayables(asRpcClient(staff.supabase), id.data);
    return view ? toSupplierPayables(view) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load supplier payables. Please retry.');
  }
}

export async function loadTallyExports(staff: Staff, limit = 50): Promise<TallyExportsView | null> {
  try {
    const view = await accountsTallyExports(asRpcClient(staff.supabase), limit);
    return view ? toTallyExports(view) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load Tally exports. Please retry.');
  }
}

export async function loadAdminAccountsSettings(staff: Staff, entityId: string): Promise<AdminAccountsSettingsView | null> {
  const id = z.uuid().safeParse(entityId);
  if (!id.success) return null;
  try {
    const view = await adminAccountsSettings(asRpcClient(staff.supabase), id.data);
    return view ? toAdminAccountsSettings(view) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load Accounts settings. Please retry.');
  }
}

/** Addendum B2: tasks this supplier bill may be linked to (null when the person may not link it). */
export async function loadLinkTargets(staff: Staff, documentId: string): Promise<LinkTargetsView | null> {
  const id = z.uuid().safeParse(documentId);
  if (!id.success) return null;
  try {
    return await supplierDocumentLinkTargets(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the tasks for this bill. Please retry.');
  }
}

/** Addendum B2: branches, suppliers and Sales owners for the workspace and dues filters. */
export async function loadFilterOptions(staff: Staff): Promise<FilterOptionsView | null> {
  try {
    return await accountsFilterOptions(asRpcClient(staff.supabase));
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the filter choices. Please retry.');
  }
}

/** Accounts phase 2 (8.1 D1): the Tally mapping grid of one entity (Accounts of the entity; null otherwise). */
export async function loadTallyMapping(staff: Staff, entityId: string): Promise<TallyMappingView | null> {
  const id = z.uuid().safeParse(entityId);
  if (!id.success) return null;
  try {
    const view = await tallyMappingList(asRpcClient(staff.supabase), id.data);
    return view ? toTallyMapping(view) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the Tally mapping. Please retry.');
  }
}

/** History of one Tally mapping row (Accounts of the entity; null otherwise). */
export async function loadTallyMappingHistory(staff: Staff, mappingId: string): Promise<TallyMappingHistoryView | null> {
  const id = z.uuid().safeParse(mappingId);
  if (!id.success) return null;
  try {
    const view = await tallyMappingHistory(asRpcClient(staff.supabase), id.data);
    return view ? toTallyMappingHistory(view) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the mapping history. Please retry.');
  }
}
