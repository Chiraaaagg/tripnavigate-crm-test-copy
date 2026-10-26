import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import { BookingPanelSchema, type BookingPanelRecord, type PurchaseTaskDetailRecord } from '@/modules/fulfilment/commands';
import { ERROR_TEXT, ISSUE_TEXT } from '@/modules/fulfilment/contracts';
import {
  type BookingDealFacts,
  BookingShapeError,
  nightsBetween,
  toBookingPanelView,
  toPurchaseTaskSummary,
  toPurchaseTaskView,
} from '@/modules/fulfilment/dto';

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const PURCHASER = 'a0000000-0000-4000-8000-000000000009';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = '44444444-4444-4444-8444-444444444444';
const HASH = 'b'.repeat(64);

const rolePermissions: ViewerAccess['rolePermissions'] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'sales', permissionCode: 'deal.read_commercial', scope: 'own' },
  { roleCode: 'purchase', permissionCode: 'deal.read', scope: 'own' },
];
const sales: ViewerAccess = {
  userId: OWNER,
  memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'sales' }],
  rolePermissions,
  grants: [],
};
const purchase: ViewerAccess = {
  userId: PURCHASER,
  memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'purchase' }],
  rolePermissions,
  grants: [],
};
const deal: BookingDealFacts = {
  id: DEAL,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  ownerUserId: OWNER,
  activeAssigneeIds: [PURCHASER],
};

function panel(over: Partial<BookingPanelRecord> = {}): BookingPanelRecord {
  return BookingPanelSchema.parse({
    dealId: DEAL,
    canEdit: true,
    canConfirm: true,
    gate: { realBookingEnabled: false, environment: 'test' },
    version: {
      versionId: VERSION,
      versionNo: 1,
      status: 'draft',
      rowVersion: 3,
      contentHash: HASH,
      facts: {
        hotelName: 'Synthetic Palace',
        city: 'Jaipur',
        checkIn: '2026-11-01',
        checkOut: '2026-11-04',
        rooms: 1,
        adults: 2,
        children: 1,
        purchaseBudgetPaise: 1500000,
      },
      sellingTotalPaise: '2000000',
    },
    readiness: { ready: true, issues: [], contentHash: HASH },
    evidence: [
      {
        id: EVIDENCE,
        kind: 'ticket',
        fileName: 'ticket.pdf',
        sizeBytes: 2048,
        status: 'stored',
        uploadedByYou: true,
        createdAt: '2026-10-02T10:00:00Z',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'other',
        fileName: 'old.pdf',
        sizeBytes: 10,
        status: 'removed',
        uploadedByYou: true,
        createdAt: '2026-10-02T09:00:00Z',
      },
    ],
    evidenceVisible: true,
    task: null,
    ...over,
  });
}

describe('toBookingPanelView', () => {
  it('shows a ready draft with the selling total to a commercial reader', () => {
    const view = toBookingPanelView(sales, deal, panel());
    expect(view.state).toBe('draft_ready');
    expect(view.canConfirm).toBe(true);
    expect(view.sellingTotalPaise).toBe('2000000');
    expect(view.facts?.purchaseBudgetPaise).toBe('1500000');
    expect(view.contentHash).toBe(HASH);
    expect(view.evidence.map((e) => e.id)).toEqual([EVIDENCE]);
    expect(view.evidence[0]!.sizeLabel).toBe('2 KB');
  });

  it('omits the selling total key entirely when the policy mirror refuses (Purchase role)', () => {
    const view = toBookingPanelView(purchase, deal, panel());
    expect('sellingTotalPaise' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain('2000000');
  });

  it('omits the selling field when the database withheld the amount, even if the policy mirror allows it (re-review L-b)', () => {
    const base = panel();
    const { sellingTotalPaise: _withheld, ...versionWithoutAmount } = base.version!;
    void _withheld;
    const record = BookingPanelSchema.parse({ ...base, version: versionWithoutAmount });
    expect(record.version!.sellingTotalPaise).toBeUndefined();
    const view = toBookingPanelView(sales, deal, record);
    expect('sellingTotalPaise' in view).toBe(false);
  });

  it('keeps a readable but unset selling total as null (field shown empty)', () => {
    const base = panel();
    const view = toBookingPanelView(sales, deal, BookingPanelSchema.parse({ ...base, version: { ...base.version!, sellingTotalPaise: null } }));
    expect(view.sellingTotalPaise).toBeNull();
  });

  it('needs repair: lists issues and cannot confirm; no blocked reason beyond the list', () => {
    const view = toBookingPanelView(
      sales,
      deal,
      panel({ readiness: { ready: false, issues: ['missing_acceptance_proof'], contentHash: HASH } }),
    );
    expect(view.state).toBe('draft_needs_repair');
    expect(view.canConfirm).toBe(false);
    expect(view.issues).toEqual(['missing_acceptance_proof']);
    expect(view.confirmBlockedReason).toBeNull();
  });

  it('explains a gate block and a missing confirm right', () => {
    const gated = toBookingPanelView(
      sales,
      deal,
      panel({ readiness: { ready: false, issues: ['booking_disabled'], contentHash: HASH } }),
    );
    expect(gated.confirmBlockedReason).toBe(ISSUE_TEXT.booking_disabled);
    const assignee = toBookingPanelView(sales, deal, panel({ canConfirm: false }));
    expect(assignee.canEdit).toBe(true);
    expect(assignee.canConfirm).toBe(false);
    expect(assignee.confirmBlockedReason).toBe(ERROR_TEXT.not_authorized);
  });

  it('says why a booking cannot be started on a lost or rejected deal, only when one could otherwise be started (Stage 7)', () => {
    const none = { version: null, readiness: null, evidence: [] };
    const blocked = toBookingPanelView(sales, deal, panel({ ...none, dealNotActive: true }));
    expect(blocked.state).toBe('none');
    expect(blocked.openBlockedReason).toBe(ERROR_TEXT.deal_not_active);
    expect(toBookingPanelView(sales, deal, panel({ ...none, dealNotActive: false })).openBlockedReason).toBeNull();
    // Older databases do not send the key: not blocked.
    expect(toBookingPanelView(sales, deal, panel(none)).openBlockedReason).toBeNull();
    // Readers who could not start one anyway see the same reason (consistent view).
    expect(toBookingPanelView(sales, deal, panel({ ...none, canEdit: false, dealNotActive: true })).openBlockedReason).toBe(
      ERROR_TEXT.deal_not_active,
    );
    // An existing draft stays editable and is not marked blocked.
    const draft = toBookingPanelView(sales, deal, panel({ dealNotActive: true }));
    expect(draft.canEdit).toBe(true);
    expect(draft.openBlockedReason).toBeNull();
  });

  it('confirmed: not editable, task facts present', () => {
    const record = panel({ task: { taskId: TASK, status: 'not_started', assigneeName: null } });
    record.version = { ...record.version!, status: 'confirmed', confirmedAt: '2026-10-02T11:00:00Z', confirmedByName: 'Sales A' };
    const view = toBookingPanelView(sales, deal, record);
    expect(view.state).toBe('confirmed');
    expect(view.canEdit).toBe(false);
    expect(view.canConfirm).toBe(false);
    expect(view.confirmed).toEqual({
      at: '2026-10-02T11:00:00Z',
      byName: 'Sales A',
      taskId: TASK,
      taskStatus: 'not_started',
      taskAssigneeName: null,
    });
  });

  it('refuses to show "confirmed" without its task, and a panel for another deal', () => {
    const record = panel();
    record.version = { ...record.version!, status: 'confirmed', confirmedAt: '2026-10-02T11:00:00Z' };
    expect(() => toBookingPanelView(sales, deal, record)).toThrow(BookingShapeError);
    expect(() => toBookingPanelView(sales, { ...deal, id: VERSION }, panel())).toThrow(BookingShapeError);
  });

  it('no version yet → state none', () => {
    const view = toBookingPanelView(sales, deal, panel({ version: null, readiness: null, evidence: [] }));
    expect(view.state).toBe('none');
    expect(view.facts).toBeNull();
    expect(view.canConfirm).toBe(false);
  });
});

describe('Purchase DTOs', () => {
  const leakyRow = {
    taskId: TASK,
    dealReference: 'SYN-0001',
    hotelName: 'Synthetic Palace',
    city: 'Jaipur',
    checkIn: '2026-11-01',
    checkOut: '2026-11-04',
    rooms: 1,
    adults: 2,
    children: 0,
    purchaseBudgetPaise: '1500000',
    status: 'not_started',
    assigneeName: null,
    assignedToYou: false,
    branchName: 'Delhi',
    createdAt: '2026-10-02T11:00:00Z',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    inclusions: null,
    specialRequests: null,
    confirmedAt: '2026-10-02T11:00:00Z',
    confirmedByName: 'Sales A',
    versionNo: 1,
    canClaim: true,
    // Fields that must never pass through, even if a query returned them:
    selling_total: 9876543,
    selling_total_paise: '9876543',
    sellingTotalPaise: '9876543',
    estimated_margin_paise: '1234567',
    marginPaise: '1234567',
    evidence: [{ objectPath: 'e/d/v/x', fileName: 'bill.pdf' }],
    objectPath: 'e/d/v/x',
  } as unknown as PurchaseTaskDetailRecord;

  it('summary and detail never serialize selling, margin or evidence keys or values', () => {
    for (const dto of [toPurchaseTaskSummary(leakyRow), toPurchaseTaskView(leakyRow)]) {
      const json = JSON.stringify(dto);
      expect(json).not.toMatch(/selling|margin|evidence|objectPath|bill\.pdf/i);
      expect(json).not.toContain('9876543');
      expect(json).not.toContain('1234567');
      expect(json).toContain('1500000');
    }
  });

  it('computes nights from dates', () => {
    expect(toPurchaseTaskSummary(leakyRow).nights).toBe(3);
    expect(toPurchaseTaskSummary(leakyRow).travellers).toEqual({ adults: 2, children: 0 });
  });
});

describe('nightsBetween', () => {
  it('counts calendar nights, including across DST-free month ends', () => {
    expect(nightsBetween('2026-10-30', '2026-11-02')).toBe(3);
    expect(nightsBetween('2026-11-02', '2026-11-02')).toBe(0);
    expect(nightsBetween('2026-11-03', '2026-11-02')).toBe(0);
    expect(nightsBetween('bad', '2026-11-02')).toBe(0);
  });
});
