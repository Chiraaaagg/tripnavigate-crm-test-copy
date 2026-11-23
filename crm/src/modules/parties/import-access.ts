/*
 * Who may import which list (Atlas shapes v1 §h, recorded choice): hotels =
 * Super Admin; customers = Accounts (never anyone holding Purchase in that
 * company). Application mirror only, used to pick the company and to show
 * or hide the page; the database checks again on every import command.
 * Pure (no server imports).
 */

import type { ViewerAccess } from '@/modules/access/policy';
import type { ImportKind } from './import-mapping';

/** The main role per list (wording). Suppliers (Accounts phase 2, LD21): Accounts, or a Super Admin. */
export const IMPORT_ROLE: Record<ImportKind, string> = { hotel: 'super_admin', customer: 'accounts', supplier: 'accounts' };

function holds(viewer: ViewerAccess, role: string, entityId: string): boolean {
  return viewer.memberships.some((m) => m.legalEntityId === entityId && m.roleCode === role);
}

/** Companies where the viewer may import this kind of list. */
export function importEntityIds(viewer: ViewerAccess, kind: ImportKind): string[] {
  const entities = [...new Set(viewer.memberships.map((m) => m.legalEntityId))];
  if (kind === 'supplier') {
    // authz.vn_import_role: Accounts without Purchase, or Super Admin (can_switch_live_settings).
    return entities.filter((e) => (holds(viewer, 'accounts', e) && !holds(viewer, 'purchase', e)) || holds(viewer, 'super_admin', e));
  }
  return entities.filter((e) => holds(viewer, IMPORT_ROLE[kind], e) && !holds(viewer, 'purchase', e));
}

export type ImportEntityChoice = { ok: true; entityId: string } | { ok: false; reason: 'no_access' | 'several' };

/** The one company an import goes to. Several companies are refused (the pilot has one; never a guess). */
export function importEntity(viewer: ViewerAccess, kind: ImportKind): ImportEntityChoice {
  const ids = importEntityIds(viewer, kind);
  if (ids.length === 0) return { ok: false, reason: 'no_access' };
  if (ids.length > 1) return { ok: false, reason: 'several' };
  return { ok: true, entityId: ids[0]! };
}

/**
 * Accounts phase 3 (contract 9.4, LD22): rate sheets — Purchase or a Super Admin of the company
 * (authz.vn_import_role 'rate_sheet'). The database checks again, with the rate contracts switch.
 */
export function rateSheetEntity(viewer: ViewerAccess): ImportEntityChoice {
  const entities = [...new Set(viewer.memberships.map((m) => m.legalEntityId))];
  const ids = entities.filter((e) => holds(viewer, 'purchase', e) || holds(viewer, 'super_admin', e));
  if (ids.length === 0) return { ok: false, reason: 'no_access' };
  if (ids.length > 1) return { ok: false, reason: 'several' };
  return { ok: true, entityId: ids[0]! };
}

export const RATE_SHEET_NO_ACCESS_TEXT = 'Only Purchase or a Super Admin can import rate sheets.';

export const IMPORT_ACCESS_TEXT = {
  no_access: {
    hotel: 'Only a Super Admin can import the hotel list.',
    customer: 'Only Accounts can import the customer list.',
    supplier: 'Only Accounts or a Super Admin can import the supplier list.',
  },
  several: 'You work for more than one company, and an import goes to one company only. Ask the lead to set this up. Nothing was imported.',
} as const;

/**
 * Companies where the viewer holds Accounts (and not Purchase): the Accounts customer check
 * screens and their documents (Echo-A L12). Not tied to the finance switch: checking customers
 * is a data-quality step, and the database decides every read again.
 */
export function accountsRoleEntityIds(viewer: ViewerAccess): string[] {
  return importEntityIds(viewer, 'customer');
}
