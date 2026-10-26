/*
 * Who may import which list (Atlas shapes v1 §h, recorded choice): hotels =
 * Super Admin; customers = Accounts (never anyone holding Purchase in that
 * company). Application mirror only, used to pick the company and to show
 * or hide the page; the database checks again on every import command.
 * Pure (no server imports).
 */

import type { ViewerAccess } from '@/modules/access/policy';
import type { ImportKind } from './import-mapping';

export const IMPORT_ROLE: Record<ImportKind, string> = { hotel: 'super_admin', customer: 'accounts' };

function holds(viewer: ViewerAccess, role: string, entityId: string): boolean {
  return viewer.memberships.some((m) => m.legalEntityId === entityId && m.roleCode === role);
}

/** Companies where the viewer may import this kind of list. */
export function importEntityIds(viewer: ViewerAccess, kind: ImportKind): string[] {
  const entities = [...new Set(viewer.memberships.map((m) => m.legalEntityId))];
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

export const IMPORT_ACCESS_TEXT = {
  no_access: { hotel: 'Only a Super Admin can import the hotel list.', customer: 'Only Accounts can import the customer list.' },
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
