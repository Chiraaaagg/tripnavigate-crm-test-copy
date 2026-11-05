import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  type RolePermissionFact,
  type ViewerAccess,
  administeredEntityIds,
  canClaimPurchaseTask,
  canConfirmBooking,
  canEditBookingDraft,
  canReadBooking,
  canReadBookingEvidence,
  canReadDeal,
  canReadDealCommercial,
  canReadPurchaseTask,
  isBranchSalesManager,
} from '@/modules/access/policy';
import { formatPaise, toDealDetail, toDealListItem } from '@/modules/deals/dto';

// Mirrors supabase/migrations/20261001000200_reference_data.sql.
const rolePermissions: RolePermissionFact[] = [
  ...['sales', 'accounts', 'purchase', 'flight', 'visa', 'manager'].map((r) => ({
    roleCode: r,
    permissionCode: 'deal.read',
    scope: 'own' as const,
  })),
  ...['sales', 'accounts', 'manager'].map((r) => ({
    roleCode: r,
    permissionCode: 'deal.read_commercial',
    scope: 'own' as const,
  })),
  ...['staff.invite', 'staff.manage', 'access.grant', 'audit.read', 'integration.manage'].map((p) => ({
    roleCode: 'super_admin',
    permissionCode: p,
    scope: 'entity' as const,
  })),
];

const E = 'entity-a';
const viewer = (userId: string, roleCode: string, branchId = 'del', grants: ViewerAccess['grants'] = []): ViewerAccess => ({
  userId,
  memberships: [{ legalEntityId: E, branchId, roleCode }],
  rolePermissions,
  grants,
});
const deal = { legalEntityId: E, branchId: 'del', ownerUserId: 'sales-a', activeAssigneeIds: ['purchase-1'] };

describe('application mirror of the access model', () => {
  it('owner and assignee can read; others cannot', () => {
    expect(canReadDeal(viewer('sales-a', 'sales'), deal)).toBe(true);
    expect(canReadDeal(viewer('purchase-1', 'purchase', 'jdh'), deal)).toBe(true);
    expect(canReadDeal(viewer('sales-b', 'sales'), deal)).toBe(false);
    expect(canReadDeal(viewer('manager', 'manager'), deal)).toBe(false);
  });

  it('explicit grants widen to their branch or entity only', () => {
    expect(canReadDeal(viewer('m', 'manager', 'del', [{ permissionCode: 'deal.read', legalEntityId: E, branchId: 'del' }]), deal)).toBe(true);
    expect(canReadDeal(viewer('m', 'manager', 'amd', [{ permissionCode: 'deal.read', legalEntityId: E, branchId: 'amd' }]), deal)).toBe(false);
    expect(canReadDeal(viewer('m', 'manager', 'amd', [{ permissionCode: 'deal.read', legalEntityId: 'entity-b', branchId: null }]), deal)).toBe(false);
  });

  it('a grant without a membership in that entity is inert', () => {
    const v: ViewerAccess = { userId: 'x', memberships: [], rolePermissions, grants: [{ permissionCode: 'deal.read', legalEntityId: E, branchId: null }] };
    expect(canReadDeal(v, deal)).toBe(false);
  });

  it('Purchase never reads commercial values, even with a grant or a second role', () => {
    const p = viewer('purchase-1', 'purchase', 'jdh', [{ permissionCode: 'deal.read_commercial', legalEntityId: E, branchId: null }]);
    expect(canReadDealCommercial(p, deal)).toBe(false);
    const dual: ViewerAccess = { ...p, memberships: [...p.memberships, { legalEntityId: E, branchId: 'del', roleCode: 'sales' }] };
    expect(canReadDealCommercial(dual, { ...deal, ownerUserId: 'purchase-1' })).toBe(false);
  });

  it('Super Admin administers but has no deal access', () => {
    const a = viewer('admin', 'super_admin', 'jdh');
    expect(canReadDeal(a, deal)).toBe(false);
    expect(administeredEntityIds(a, 'staff.manage')).toEqual([E]);
    expect(administeredEntityIds(viewer('sales-a', 'sales'), 'staff.manage')).toEqual([]);
  });

  it('integration.manage belongs to Super Admin only (entity scope)', () => {
    expect(administeredEntityIds(viewer('admin', 'super_admin', 'jdh'), 'integration.manage')).toEqual([E]);
    for (const role of ['sales', 'accounts', 'purchase', 'flight', 'visa', 'manager']) {
      expect(administeredEntityIds(viewer('x', role), 'integration.manage')).toEqual([]);
    }
  });
});

describe('Phase 3 booking mirror (contract §4)', () => {
  const delhiGrant = [{ permissionCode: 'deal.read', legalEntityId: E, branchId: 'del' }];
  const booking = { ...deal, activeSalesAssigneeIds: ['sales-b'], activeAssigneeIds: ['purchase-1', 'sales-b'] };

  it('lists the Phase 3 permission codes', () => {
    expect(PERMISSIONS).toEqual(expect.arrayContaining(['booking.manage_draft', 'booking.confirm', 'purchase_task.read']));
  });

  it('owner edits and confirms; a Sales assignee edits but never confirms', () => {
    expect(canEditBookingDraft(viewer('sales-a', 'sales'), booking)).toBe(true);
    expect(canConfirmBooking(viewer('sales-a', 'sales'), booking)).toBe(true);
    expect(canEditBookingDraft(viewer('sales-b', 'sales'), booking)).toBe(true);
    expect(canConfirmBooking(viewer('sales-b', 'sales'), booking)).toBe(false);
    // A non-sales assignment kind does not make a Sales editor.
    expect(canEditBookingDraft(viewer('sales-c', 'sales'), { ...booking, activeAssigneeIds: ['sales-c'] })).toBe(false);
  });

  it('a manager confirms only in the deal branch and only when they can read the deal (P3-D3a)', () => {
    const inBranch = viewer('m', 'manager', 'del', delhiGrant);
    expect(isBranchSalesManager(inBranch, booking)).toBe(true);
    expect(canConfirmBooking(inBranch, booking)).toBe(true);
    expect(canEditBookingDraft(inBranch, booking)).toBe(true);
    expect(canConfirmBooking(viewer('m', 'manager', 'del'), booking)).toBe(false); // cannot read the deal
    expect(canConfirmBooking(viewer('m', 'manager', 'amd', delhiGrant), booking)).toBe(false); // other branch
  });

  it('Purchase never edits, confirms or reads evidence, but sees and claims every entity task (P3-D4)', () => {
    const p = viewer('purchase-1', 'purchase', 'jdh');
    expect(canReadDeal(p, booking)).toBe(true);
    expect(canEditBookingDraft(p, booking)).toBe(false);
    expect(canConfirmBooking(p, booking)).toBe(false);
    expect(canReadBookingEvidence(p, booking)).toBe(false);
    const unassigned = { ...deal, activeAssigneeIds: [] };
    expect(canReadPurchaseTask(p, { legalEntityId: E, deal: unassigned })).toBe(true);
    expect(canClaimPurchaseTask(p, { legalEntityId: E })).toBe(true);
    expect(canClaimPurchaseTask(p, { legalEntityId: 'entity-b' })).toBe(false);
    expect(canReadPurchaseTask(p, { legalEntityId: 'entity-b', deal: { ...unassigned, legalEntityId: 'entity-b' } })).toBe(false);
  });

  it('deal readers see the task status; others do not; nobody but Purchase claims', () => {
    expect(canReadPurchaseTask(viewer('sales-a', 'sales'), { legalEntityId: E, deal })).toBe(true);
    expect(canReadPurchaseTask(viewer('sales-b', 'sales'), { legalEntityId: E, deal })).toBe(false);
    expect(canClaimPurchaseTask(viewer('sales-a', 'sales'), { legalEntityId: E })).toBe(false);
    const facts = { ...deal, activeSalesAssigneeIds: [] };
    expect(canReadBookingEvidence(viewer('sales-a', 'sales'), facts)).toBe(true);
    expect(canReadBookingEvidence(viewer('admin', 'super_admin', 'jdh'), facts)).toBe(false);
  });

  it('A4 M2: deal readers who cannot edit or confirm read the booking but not its evidence', () => {
    const facts = { ...deal, activeSalesAssigneeIds: [], activeAssigneeIds: ['visa-1'] };
    const accounts = viewer('acc', 'accounts', 'jdh', [{ permissionCode: 'deal.read', legalEntityId: E, branchId: null }]);
    for (const v of [viewer('visa-1', 'visa', 'jdh'), accounts]) {
      expect(canReadDeal(v, facts)).toBe(true);
      expect(canReadBooking(v, facts)).toBe(true);
      expect(canReadBookingEvidence(v, facts)).toBe(false);
    }
    expect(canReadBooking(viewer('purchase-1', 'purchase', 'jdh'), deal)).toBe(false);
  });
});

describe('deal DTOs', () => {
  const row = {
    id: 'd1',
    legal_entity_id: E,
    branch_id: 'del',
    reference: 'SYN-DEL-001',
    title: 'Synthetic',
    owner_user_id: 'sales-a',
    created_at: '2026-10-01T00:00:00Z',
  };
  const assignments = [{ deal_id: 'd1', user_id: 'purchase-1', assignment_kind: 'purchase' }];
  const commercial = { deal_id: 'd1', currency: 'INR', selling_total_paise: '12345600', estimated_margin_paise: 1111100 };
  const names = new Map([['del', 'Delhi']]);

  it('omits commercial values for Purchase even if a query returned them', () => {
    const dto = toDealDetail(viewer('purchase-1', 'purchase', 'jdh'), row, assignments, commercial, names);
    expect(dto.commercial).toEqual({ visible: false });
    expect(JSON.stringify(dto)).not.toMatch(/123|1111|selling_total|margin_paise/);
  });

  it('includes formatted values for the owning Sales user', () => {
    const dto = toDealDetail(viewer('sales-a', 'sales'), row, assignments, commercial, names);
    expect(dto.commercial).toEqual({
      visible: true,
      currency: 'INR',
      sellingTotal: '₹1,23,456.00',
      estimatedMargin: '₹11,111.00',
    });
    expect(dto.relation).toBe('owner');
    expect(dto.assignments).toEqual([{ kind: 'purchase', isYou: false }]);
  });

  it('formats paise exactly without floating point', () => {
    expect(formatPaise(1)).toBe('₹0.01');
    expect(formatPaise('9007199254740993')).toBe('₹9,00,71,99,25,47,409.93');
    expect(formatPaise('123456789012345678901')).toBe('₹12,34,56,78,90,12,34,56,789.01');
    expect(formatPaise(-250)).toBe('-₹2.50');
  });

  it('a synthetic deal has no source view', () => {
    const dto = toDealListItem(viewer('sales-a', 'sales'), row, assignments, names);
    expect(dto.source).toBeUndefined();
    expect('source' in dto).toBe(false);
  });

  it('a Bitrix-imported deal carries a read-only source view with a 24 h stale flag on last_verified_at', () => {
    const imported = {
      ...row,
      reference: 'BX-6901',
      source_system: 'bitrix',
      source_deal_id: 6901,
      source_stage_id: 'C7:NEW',
      last_synced_at: '2026-09-25T00:00:00+00:00',
      last_verified_at: '2026-10-01T00:00:00+00:00',
    };
    const fresh = toDealListItem(viewer('sales-a', 'sales'), imported, [], names, new Date('2026-10-01T23:59:00Z'));
    expect(fresh.source).toEqual({
      system: 'bitrix',
      sourceDealId: '6901',
      stageId: 'C7:NEW',
      lastSyncedAt: '2026-09-25T00:00:00+00:00',
      lastVerifiedAt: '2026-10-01T00:00:00+00:00',
      stale: false,
    });
    const old = toDealDetail(viewer('sales-a', 'sales'), imported, [], null, names, new Date('2026-10-02T00:00:01Z'));
    expect(old.source?.stale).toBe(true);
    expect(old.commercial).toEqual({ visible: false });
  });
});
