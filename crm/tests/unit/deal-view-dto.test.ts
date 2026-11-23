import { describe, expect, it } from 'vitest';
import type { RolePermissionFact, ViewerAccess } from '@/modules/access/policy';
import { toDealDetail } from '@/modules/deals/dto';
import { sectionStatus, sectionStatusText } from '@/views/booking-fields';

/*
 * Phase 3.5: the deal DTO says WHY commercial values are absent, so the page
 * can show "Not recorded yet" separately from "Hidden for your role".
 */

const rolePermissions: RolePermissionFact[] = [
  ...['sales', 'purchase', 'manager'].map((r) => ({ roleCode: r, permissionCode: 'deal.read', scope: 'own' as const })),
  ...['sales', 'manager'].map((r) => ({ roleCode: r, permissionCode: 'deal.read_commercial', scope: 'own' as const })),
];
const E = 'entity-a';
const viewer = (userId: string, roleCode: string, branchId = 'del'): ViewerAccess => ({
  userId,
  memberships: [{ legalEntityId: E, branchId, roleCode }],
  rolePermissions,
  grants: [],
});
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

describe('deal DTO: why commercial values are absent', () => {
  it('visible values carry no absence reason', () => {
    const dto = toDealDetail(viewer('sales-a', 'sales'), row, assignments, commercial, names);
    expect(dto.commercial.visible).toBe(true);
    expect('commercialAbsence' in dto).toBe(false);
  });

  it('a role that may not read them gets "withheld", even if a query returned values', () => {
    const dto = toDealDetail(viewer('purchase-1', 'purchase', 'jdh'), row, assignments, commercial, names);
    expect(dto.commercial).toEqual({ visible: false });
    expect(dto.commercialAbsence).toBe('withheld');
    expect(JSON.stringify(dto)).not.toMatch(/123|1111|selling_total|margin_paise/);
  });

  it('a permitted viewer with no commercial row gets "not_recorded"', () => {
    const dto = toDealDetail(viewer('sales-a', 'sales'), row, assignments, null, names);
    expect(dto.commercial).toEqual({ visible: false });
    expect(dto.commercialAbsence).toBe('not_recorded');
  });

  it('a non-permitted viewer with no row is still "withheld" (absence never reveals existence)', () => {
    const dto = toDealDetail(viewer('purchase-1', 'purchase', 'jdh'), row, assignments, null, names);
    expect(dto.commercialAbsence).toBe('withheld');
  });
});

describe('booking form section status', () => {
  const all = [
    'hotelName',
    'city',
    'checkIn',
    'checkOut',
    'rooms',
    'roomType',
    'mealPlan',
    'adults',
    'children',
    'inclusions',
    'specialRequests',
    'purchaseBudgetRupees',
    'sellingTotalRupees',
  ] as const;
  const rendered = [...all];

  it('counts missing required fields and ignores optional ones', () => {
    const st = sectionStatus('rooms', { rooms: '2', adults: '', roomType: '' }, rendered, []);
    expect(st).toEqual({ kind: 'missing', count: 1 });
    expect(sectionStatusText(st)).toBe('1 to add');
    expect(sectionStatus('rooms', { rooms: '2', adults: '3' }, rendered, [])).toEqual({ kind: 'done' });
    expect(sectionStatus('notes', {}, rendered, [])).toEqual({ kind: 'optional' });
  });

  it('a hidden booking total is not counted as missing', () => {
    const withoutTotal = rendered.filter((f) => f !== 'sellingTotalRupees');
    expect(sectionStatus('money', { purchaseBudgetRupees: '450.00' }, withoutTotal, [])).toEqual({ kind: 'done' });
    expect(sectionStatus('money', { purchaseBudgetRupees: '450.00' }, rendered, [])).toEqual({ kind: 'missing', count: 1 });
  });

  it('a field flagged by the server with a value present asks to check it', () => {
    const st = sectionStatus('stay', { hotelName: 'H', city: 'C', checkIn: '2026-11-17', checkOut: '2026-11-14' }, rendered, ['checkOut']);
    expect(st).toEqual({ kind: 'attention' });
    expect(sectionStatusText(st)).toBe('Check this');
  });
});

describe('deal DTO: created date', () => {
  it('is the IST calendar day, not the UTC one', () => {
    // 00:30 IST on 6 October is still 5 October in UTC.
    const dto = toDealDetail(viewer('sales-a', 'sales'), { ...row, created_at: '2026-10-05T19:00:00+00:00' }, assignments, null, names);
    expect(dto.createdOn).toBe('2026-10-06');
  });

  it('keeps the same day for a mid-day timestamp', () => {
    const dto = toDealDetail(viewer('sales-a', 'sales'), { ...row, created_at: '2026-10-06T08:00:00+00:00' }, assignments, null, names);
    expect(dto.createdOn).toBe('2026-10-06');
  });
});
