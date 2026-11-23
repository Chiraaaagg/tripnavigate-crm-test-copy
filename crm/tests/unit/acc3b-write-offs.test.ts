import { describe, expect, it } from 'vitest';
import { HOLD_CODES, HOLD_REASON_TEXT } from '@/modules/customer-documents/contracts';
import { DealDocumentsSchema, DocumentListSchema } from '@/modules/customer-documents/dto';
import { mapWriteOffError } from '@/modules/write-offs/commands';
import { WRITE_OFF_BLOCK_CODES, WRITE_OFF_BLOCK_TEXT, WRITE_OFF_ERROR_STATES, WRITE_OFF_ERROR_TEXT } from '@/modules/write-offs/contracts';
import { DuesWriteOffKeysSchema, SmallBalancesPageSchema, WriteOffCommandResultSchema } from '@/modules/write-offs/dto';
import { WRITE_OFF_MAX_LIMIT_PAISE, limitAllowed, writeOffProblem } from '@/modules/write-offs/limits';

/**
 * Accounts phase 3, track B's own unit checks: the write-off amount mirror,
 * token mapping, frozen words and the strict DTOs. Synthetic values only.
 */

const ID = '11111111-1111-4111-8111-111111111111';

describe('write-off limits mirror', () => {
  it('whole balance first, then the limit', () => {
    const base = { balancePaise: '300', creditPaise: '0', limitPaise: '500000' };
    expect(writeOffProblem({ ...base, direction: 'due', amountPaise: '300' })).toBeNull();
    expect(writeOffProblem({ ...base, direction: 'due', amountPaise: '299' })).toBe('write_off_not_balance');
    expect(writeOffProblem({ ...base, direction: 'excess', amountPaise: '300' })).toBe('write_off_not_balance');
    expect(writeOffProblem({ direction: 'due', balancePaise: '600000', creditPaise: '0', limitPaise: '500000', amountPaise: '600000' }))
      .toBe('write_off_over_limit');
    expect(writeOffProblem({ ...base, direction: 'due', amountPaise: '3.5' })).toBe('write_off_not_balance');
    expect(WRITE_OFF_MAX_LIMIT_PAISE).toBe(500000n);
    expect(limitAllowed('500000')).toBe(true);
    expect(limitAllowed('500001')).toBe(false);
    expect(limitAllowed('0')).toBe(false);
  });
});

describe('tokens and words', () => {
  it('maps a token only with its own SQLSTATE', () => {
    for (const [token, state] of Object.entries(WRITE_OFF_ERROR_STATES)) {
      expect(mapWriteOffError({ code: state, message: token })).toBe(token);
      expect(WRITE_OFF_ERROR_TEXT[token as keyof typeof WRITE_OFF_ERROR_TEXT]).toBeTruthy();
    }
    expect(mapWriteOffError({ code: '55000', message: 'write_off_over_limit' })).toBeNull();
    expect(WRITE_OFF_ERROR_TEXT.write_off_not_balance).toBe('A write-off must be the whole remaining balance.');
  });
  it('every block code and hold code has words', () => {
    for (const c of WRITE_OFF_BLOCK_CODES) expect(WRITE_OFF_BLOCK_TEXT[c]).toBeTruthy();
    expect(HOLD_CODES).toHaveLength(11);
    for (const c of HOLD_CODES) expect(HOLD_REASON_TEXT[c]).toBeTruthy();
  });
});

describe('strict DTOs', () => {
  it('small balances page refuses extra keys; dues keys; command result', () => {
    const page = {
      items: [{ dealId: ID, dealReference: 'SYN-DEL-001', branchName: 'Delhi', tripEnd: '2026-11-01', direction: 'due', balancePaise: '300',
        limitPaise: '500000', writeOff: null, blockedBy: [], can: { propose: true, approve: false, return: false, withdraw: false, undo: false } }],
      nextAfter: `2026-11-01|${ID}`, hasMore: true,
    };
    expect(SmallBalancesPageSchema.safeParse(page).success).toBe(true);
    expect(SmallBalancesPageSchema.safeParse({ ...page, items: [{ ...page.items[0], mobile: '6000043210' }] }).success).toBe(false);
    expect(DuesWriteOffKeysSchema.safeParse({ writeOff: { refNo: 'WO-2026-000001', direction: 'excess', amountPaise: '120', status: 'approved',
      reason: 'Synthetic reason text', proposedByName: 'Accounts', decidedByName: 'Manager', decidedAt: '2026-11-13T06:00:00.000Z' },
    writeOffNeedsReview: false }).success).toBe(true);
    expect(WriteOffCommandResultSchema.safeParse({ outcome: 'created', writeOffId: ID, dealId: ID, refNo: 'WO-2026-000001', direction: 'due',
      status: 'proposed', amountPaise: '300', rowVersion: 1 }).success).toBe(true);
  });
  it('document rows accept the automatic fields; the deal read needs autoBills', () => {
    const shape = DealDocumentsSchema.shape;
    expect(Object.keys(shape)).toContain('autoBills');
    expect(DocumentListSchema.safeParse({ items: [], hasMore: false, nextAfter: null }).success).toBe(true);
  });
});
