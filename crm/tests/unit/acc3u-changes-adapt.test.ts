import { describe, expect, it } from 'vitest';
import type { ChangePreview, DealChangeRequests } from '@/modules/booking-changes/dto';
import { changeModeView, dealChangesView, factLines } from '@/views/booking-changes/adapt';
import { rateSheetSummary } from '@/views/rate-contracts/rate-sheet-import';

const ID = 'a0000001-0000-4000-8000-000000000001';

describe('booking-changes adapter (track G DTOs → screens)', () => {
  it('blocks add / remove until track H exists and names former staff', () => {
    const dto: DealChangeRequests = {
      dealId: ID,
      enabled: true,
      canRequest: true,
      blockedBy: [],
      confirmed: [{ itemId: ID, itemNo: 1, serviceTitle: 'Hotel', department: 'odd', taskStatus: 'supplier_confirmed', supplierName: null, reference: null }],
      requests: [
        {
          id: ID, refNo: 'CR-2026-000001', kind: 'change', status: 'requested', itemNos: [1], changeSummary: 'One more night', reason: 'Customer asked',
          requestedByName: null, requestedAt: '2026-11-13T05:00:00Z', decidedByName: null, decidedAt: null, returnReason: null, changeVersionId: null,
          reconfirmations: [], closeReason: null, rowVersion: 1, can: { resubmit: false, withdraw: true, openVersion: false, submit: false },
        },
      ],
    };
    const v = dealChangesView(dto);
    expect(v.serviceChangesEnabled).toBe(false);
    expect(v.confirmed[0]!.department).toBe('purchase');
    expect(v.requests[0]!.requestedByName).toBe('A former staff member');
  });

  it('fact lines are sorted, labelled and empty values become null', () => {
    const lines = factLines({ rooms: 2, checkIn: '2026-12-01', note: '' });
    expect(lines.map((l) => l.key)).toEqual(['checkIn', 'note', 'rooms']);
    expect(lines.find((l) => l.key === 'note')!.value).toBeNull();
    expect(lines.find((l) => l.key === 'rooms')!.value).toBe('2');
  });

  it('change mode only once a change version is open', () => {
    const p: ChangePreview = {
      changeRequestId: ID, refNo: 'CR-2026-000001', kind: 'change', status: 'approved', changeSummary: 'One more night', versionId: null, rowVersion: null,
      contentHash: null, requestItemIds: [ID], changedItemIds: [], itemNos: { [ID]: 1 }, outsideItemNos: [], changedFields: [], issues: [], canSubmit: false,
    };
    expect(changeModeView(p)).toBeNull();
    const open = changeModeView({ ...p, versionId: ID, rowVersion: 1, contentHash: 'a'.repeat(64) });
    expect(open?.contentHash).toBe('a'.repeat(64));
    expect(open?.requestItemIds).toEqual([ID]);
  });
});

describe('rate-sheet check summary', () => {
  it('maps a null outcome to invalid and keeps the counts', () => {
    const s = rateSheetSummary({
      batchId: ID, rowVersion: 1, proposalHash: null, fileName: 'x.csv', rowCount: 1, contracts: 0, lines: 0, newRoomTypes: 0, invalidRows: 1,
      warnings: { newRoomType: 0, overlapsActiveContract: 0 }, moreRows: 0, unknownHeaders: [],
      rows: [{ rowNo: 2, outcome: null, reasons: ['rate_invalid'], warnings: [], values: { supplierRef: 'SYN-S1' } }],
    });
    expect(s.rows[0]!.outcome).toBe('invalid');
    expect(s.rows[0]!.values.supplierRef).toBe('SYN-S1');
    expect(s.rows[0]!.values.hotelRef).toBeNull();
    expect(s.invalidRows).toBe(1);
  });
});
