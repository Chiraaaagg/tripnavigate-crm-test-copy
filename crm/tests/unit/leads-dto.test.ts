import { describe, expect, it } from 'vitest';
import type { RolePermissionFact, ViewerAccess } from '@/modules/access/policy';
import { canSeeLeads, holdsPurchaseAnywhere } from '@/modules/access/policy';
import { isLeadStale, LEAD_COLUMNS, type LeadRow, NOT_SHOWN, toLeadDetail, toLeadListItem } from '@/modules/leads/dto';

/* Lead-screens contract §1–§2: DTO mapping, stale threshold, relation hint, nav predicate. */

const E = 'entity-a';
const F = 'entity-b';
const rolePermissions: RolePermissionFact[] = [
  { roleCode: 'admin', permissionCode: 'integration.manage', scope: 'entity' },
];
const viewer = (userId: string, memberships: Array<[string, string, string]>): ViewerAccess => ({
  userId,
  memberships: memberships.map(([legalEntityId, branchId, roleCode]) => ({ legalEntityId, branchId, roleCode })),
  rolePermissions,
  grants: [],
});

const NOW = new Date('2026-10-05T12:00:00Z');
const row: LeadRow = {
  id: '11111111-1111-4111-8111-111111111111',
  reference: 'BXL-501',
  title: 'Goa family trip',
  branch_id: 'del',
  owner_user_id: 'sales-a',
  source_lead_id: 501,
  source_status_id: 'NEW',
  source_id_code: 'WEBFORM',
  source_created_at: '2026-10-04T05:00:00Z',
  last_synced_at: '2026-10-05T10:00:00Z',
  last_verified_at: '2026-10-05T10:00:00Z',
  source_portal: 'example.bitrix24.in',
};
const names = new Map([['del', 'Delhi']]);

describe('lead DTO', () => {
  it('maps header and provenance fields only', () => {
    const item = toLeadListItem(viewer('sales-a', [[E, 'del', 'sales']]), row, names, NOW);
    expect(item).toEqual({
      id: row.id,
      reference: 'BXL-501',
      title: 'Goa family trip',
      branchName: 'Delhi',
      relation: 'owner',
      source: {
        system: 'bitrix',
        sourceLeadId: '501',
        statusId: 'NEW',
        statusLabel: null,
        sourceCode: 'WEBFORM',
        sourceCodeLabel: null,
        sourceCreatedAt: '2026-10-04T05:00:00Z',
        lastSyncedAt: '2026-10-05T10:00:00Z',
        lastVerifiedAt: '2026-10-05T10:00:00Z',
        stale: false,
      },
    });
    expect(JSON.stringify(item)).not.toMatch(/phone|email|comment|amount|portal/i);
  });

  it('selects exactly the contract columns', () => {
    expect(LEAD_COLUMNS.split(',').map((c) => c.trim())).toEqual([
      'id',
      'reference',
      'title',
      'branch_id',
      'owner_user_id',
      'source_lead_id',
      'source_status_id',
      'source_id_code',
      'source_created_at',
      'last_synced_at',
      'last_verified_at',
      'source_portal',
    ]);
  });

  it('derives relation for display: owner, branch manager, else integration admin', () => {
    expect(toLeadListItem(viewer('mgr', [[E, 'del', 'manager']]), row, names, NOW).relation).toBe('branch_manager');
    expect(toLeadListItem(viewer('mgr', [[E, 'mum', 'manager']]), row, names, NOW).relation).toBe('integration_admin');
    expect(toLeadListItem(viewer('adm', [[E, 'del', 'admin']]), row, names, NOW).relation).toBe('integration_admin');
  });

  it('shows "Not shown" for unreadable branch and null for unknown or blank owner', () => {
    const v = viewer('mgr', [[E, 'del', 'manager']]);
    expect(toLeadListItem(v, row, new Map(), NOW).branchName).toBe(NOT_SHOWN);
    expect(toLeadDetail(v, row, names, null, NOW).ownerName).toBeNull();
    expect(toLeadDetail(v, row, names, '  ', NOW).ownerName).toBeNull();
    expect(toLeadDetail(v, row, names, 'Asha Rao', NOW).ownerName).toBe('Asha Rao');
  });

  it('says whether the Lead has an owner, without sending the owner id (Batch 1 ruling)', () => {
    const v = viewer('mgr', [[E, 'del', 'manager']]);
    const owned = toLeadDetail(v, row, names, null, NOW);
    expect(owned.ownerState).toBe('assigned');
    expect(JSON.stringify(owned)).not.toContain('sales-a');
    const waiting = toLeadDetail(v, { ...row, owner_user_id: null }, names, 'Stale Name', NOW);
    expect(waiting.ownerState).toBe('waiting');
    expect(waiting.ownerName).toBeNull();
    expect(Object.keys(waiting)).not.toContain('owner_user_id');
    expect(Object.keys(waiting)).not.toContain('ownerUserId');
  });

  it('marks stale beyond 24 h, on missing or unparsable timestamps', () => {
    expect(isLeadStale('2026-10-04T12:00:00Z', NOW)).toBe(false);
    expect(isLeadStale('2026-10-04T11:59:59Z', NOW)).toBe(true);
    expect(isLeadStale(null, NOW)).toBe(true);
    expect(isLeadStale('garbage', NOW)).toBe(true);
    const old = { ...row, last_verified_at: '2026-10-01T00:00:00Z' };
    expect(toLeadListItem(viewer('sales-a', [[E, 'del', 'sales']]), old, names, NOW).source.stale).toBe(true);
  });

  it('falls back to last_synced_at when last_verified_at is null', () => {
    const r = { ...row, last_verified_at: null };
    const s = toLeadListItem(viewer('sales-a', [[E, 'del', 'sales']]), r, names, NOW).source;
    expect(s.lastVerifiedAt).toBe(r.last_synced_at);
    expect(s.stale).toBe(false);
  });
});

describe('canSeeLeads (nav predicate)', () => {
  it('shows Leads to sales, manager and integration admins', () => {
    expect(canSeeLeads(viewer('u', [[E, 'del', 'sales']]))).toBe(true);
    expect(canSeeLeads(viewer('u', [[E, 'del', 'manager']]))).toBe(true);
    expect(canSeeLeads(viewer('u', [[E, 'hq', 'admin']]))).toBe(true);
  });

  it('hides Leads from Purchase, including Purchase+Sales in the same entity, and from no role', () => {
    expect(canSeeLeads(viewer('u', [[E, 'del', 'purchase']]))).toBe(false);
    expect(canSeeLeads(viewer('u', [[E, 'del', 'purchase'], [E, 'del', 'sales']]))).toBe(false);
    expect(canSeeLeads(viewer('u', [[E, 'hq', 'purchase'], [E, 'hq', 'admin']]))).toBe(false);
    expect(canSeeLeads(viewer('u', []))).toBe(false);
    expect(canSeeLeads(viewer('u', [[E, 'del', 'accounts']]))).toBe(false);
  });

  it('evaluates per entity; holdsPurchaseAnywhere flags any Purchase membership', () => {
    const multi = viewer('u', [[E, 'del', 'purchase'], [F, 'blr', 'sales']]);
    expect(canSeeLeads(multi)).toBe(true);
    expect(holdsPurchaseAnywhere(multi)).toBe(true);
    expect(holdsPurchaseAnywhere(viewer('u', [[F, 'blr', 'sales']]))).toBe(false);
  });
});
